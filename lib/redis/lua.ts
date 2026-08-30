/**
 * Lua scripts executed with EVAL on the real Redis.
 *
 * Each script is atomic on the server, which is what makes the quota ledger
 * race-free (GW-001) and the limiter burst-proof (GW-025). Every script has a
 * JavaScript twin in `scripts.ts` used by the in-memory driver so the same
 * semantics can be exercised in tests and local development.
 *
 * Invariants shared by all scripts:
 *  - they never call a non-deterministic command before a write
 *  - they return plain integers/strings (Upstash REST cannot marshal tables
 *    with mixed types reliably), using a leading status code convention
 */

/**
 * Refilling token bucket.
 * KEYS[1] bucket hash
 * ARGV[1] capacity, ARGV[2] refill-per-second, ARGV[3] now-ms, ARGV[4] cost, ARGV[5] ttl-sec
 * -> {allowed, remaining, retryAfterMs}
 */
export const TOKEN_BUCKET_LUA = `
local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local refill = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local cost = tonumber(ARGV[4])
local ttl = tonumber(ARGV[5])
if capacity <= 0 then return {1, -1, 0} end
local data = redis.call('HMGET', key, 'tokens', 'ts')
local tokens = tonumber(data[1])
local ts = tonumber(data[2])
if tokens == nil then tokens = capacity end
if ts == nil then ts = now end
local elapsed = math.max(0, now - ts) / 1000.0
tokens = math.min(capacity, tokens + elapsed * refill)
local allowed = 0
local retry = 0
if tokens >= cost then
  tokens = tokens - cost
  allowed = 1
else
  local deficit = cost - tokens
  if refill > 0 then retry = math.ceil((deficit / refill) * 1000) else retry = ttl * 1000 end
end
redis.call('HSET', key, 'tokens', tokens, 'ts', now)
redis.call('EXPIRE', key, ttl)
return {allowed, math.floor(tokens), retry}
`

/**
 * Fixed window counter with a strict ceiling.
 * KEYS[1] counter, ARGV[1] limit, ARGV[2] window-sec, ARGV[3] cost
 * -> {allowed, count, ttl}
 */
export const FIXED_WINDOW_LUA = `
local key = KEYS[1]
local limit = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local cost = tonumber(ARGV[3])
if limit <= 0 then return {1, 0, window} end
local current = tonumber(redis.call('GET', key) or '0')
if current + cost > limit then
  local ttl = redis.call('TTL', key)
  if ttl < 0 then ttl = window end
  return {0, current, ttl}
end
local updated = redis.call('INCRBY', key, cost)
if updated == cost then redis.call('EXPIRE', key, window) end
local ttl = redis.call('TTL', key)
if ttl < 0 then ttl = window end
return {1, updated, ttl}
`

/**
 * Sliding window over successful requests, implemented as a sorted set of
 * timestamps. Prevents the double-burst that a fixed window allows (GW-025).
 * KEYS[1] zset, ARGV[1] limit, ARGV[2] window-ms, ARGV[3] now-ms, ARGV[4] member
 * -> {allowed, count}
 */
export const SLIDING_SUCCESS_LUA = `
local key = KEYS[1]
local limit = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local member = ARGV[4]
if limit <= 0 then return {1, 0} end
redis.call('ZREMRANGEBYSCORE', key, 0, now - window)
local count = tonumber(redis.call('ZCARD', key) or '0')
if count >= limit then return {0, count} end
redis.call('ZADD', key, now, member)
redis.call('PEXPIRE', key, window)
return {1, count + 1}
`

/**
 * Atomic quota reservation.
 *
 * Debits the balance and records a reservation in ONE round trip so two
 * concurrent requests can never both pass a check-then-act balance test
 * (GW-001). The reservation carries the request id, which makes settlement
 * idempotent (GW-009).
 *
 * KEYS[1] user quota counter
 * KEYS[2] token quota counter ('' when the token has no private budget)
 * KEYS[3] reservation key
 * ARGV[1] amount, ARGV[2] ttl-sec, ARGV[3] request-id, ARGV[4] unlimited(0|1)
 * -> {status, remaining}  status: 1 ok, 0 insufficient, 2 duplicate
 */
export const RESERVE_LUA = `
local userKey = KEYS[1]
local tokenKey = KEYS[2]
local resvKey = KEYS[3]
local amount = tonumber(ARGV[1])
local ttl = tonumber(ARGV[2])
local requestId = ARGV[3]
local unlimited = tonumber(ARGV[4])
if redis.call('EXISTS', resvKey) == 1 then
  return {2, tonumber(redis.call('GET', userKey) or '0')}
end
if unlimited == 1 then
  redis.call('HSET', resvKey, 'amount', 0, 'rid', requestId, 'state', 'open', 'unlimited', 1)
  redis.call('EXPIRE', resvKey, ttl)
  return {1, -1}
end
local balance = tonumber(redis.call('GET', userKey) or '-1')
if balance < 0 then return {3, 0} end
if balance < amount then return {0, balance} end
local tokenBalance = -1
if tokenKey ~= '' then
  tokenBalance = tonumber(redis.call('GET', tokenKey) or '-1')
  if tokenBalance >= 0 and tokenBalance < amount then return {0, tokenBalance} end
end
local remaining = redis.call('DECRBY', userKey, amount)
if tokenKey ~= '' and tokenBalance >= 0 then
  redis.call('DECRBY', tokenKey, amount)
end
redis.call('HSET', resvKey, 'amount', amount, 'rid', requestId, 'state', 'open', 'unlimited', 0)
redis.call('EXPIRE', resvKey, ttl)
return {1, remaining}
`

/**
 * Atomic settlement: converts an open reservation into a final charge.
 *
 * Refunds (reserved - final) or debits the difference, marks the reservation
 * settled, and appends a journal entry that the reconciler drains into Mongo.
 * Re-running with the same reservation is a no-op (status 2).
 *
 * KEYS[1] user quota counter
 * KEYS[2] token quota counter or ''
 * KEYS[3] reservation key
 * KEYS[4] journal stream
 * ARGV[1] final amount, ARGV[2] request-id, ARGV[3] user-id, ARGV[4] token-id, ARGV[5] journal-ttl-sec
 * -> {status, remaining, delta} status: 1 settled, 2 already settled, 0 unknown reservation
 */
export const SETTLE_LUA = `
local userKey = KEYS[1]
local tokenKey = KEYS[2]
local resvKey = KEYS[3]
local journalKey = KEYS[4]
local final = tonumber(ARGV[1])
local requestId = ARGV[2]
local userId = ARGV[3]
local tokenId = ARGV[4]
local journalTtl = tonumber(ARGV[5])
local state = redis.call('HGET', resvKey, 'state')
if state == false then return {0, 0, 0} end
if state ~= 'open' then return {2, 0, 0} end
local reserved = tonumber(redis.call('HGET', resvKey, 'amount') or '0')
local unlimited = tonumber(redis.call('HGET', resvKey, 'unlimited') or '0')
local delta = final - reserved
local remaining = -1
if unlimited == 0 then
  if delta ~= 0 then
    remaining = redis.call('DECRBY', userKey, delta)
    if tokenKey ~= '' and redis.call('EXISTS', tokenKey) == 1 then
      redis.call('DECRBY', tokenKey, delta)
    end
  else
    remaining = tonumber(redis.call('GET', userKey) or '0')
  end
end
redis.call('HSET', resvKey, 'state', 'settled', 'final', final)
redis.call('EXPIRE', resvKey, 900)
redis.call('RPUSH', journalKey, cjson.encode({rid=requestId, uid=userId, tid=tokenId, amount=final, reserved=reserved, kind='settle'}))
redis.call('EXPIRE', journalKey, journalTtl)
return {1, remaining, delta}
`

/**
 * Releases an unsettled reservation (client aborted before any tokens were
 * produced). Full refund, journalled as a 'release'.
 *
 * KEYS[1] user quota, KEYS[2] token quota or '', KEYS[3] reservation, KEYS[4] journal
 * ARGV[1] request-id, ARGV[2] user-id, ARGV[3] token-id, ARGV[4] journal-ttl
 * -> {status, refunded}
 */
export const RELEASE_LUA = `
local userKey = KEYS[1]
local tokenKey = KEYS[2]
local resvKey = KEYS[3]
local journalKey = KEYS[4]
local state = redis.call('HGET', resvKey, 'state')
if state == false then return {0, 0} end
if state ~= 'open' then return {2, 0} end
local reserved = tonumber(redis.call('HGET', resvKey, 'amount') or '0')
local unlimited = tonumber(redis.call('HGET', resvKey, 'unlimited') or '0')
if unlimited == 0 and reserved > 0 then
  redis.call('INCRBY', userKey, reserved)
  if tokenKey ~= '' and redis.call('EXISTS', tokenKey) == 1 then
    redis.call('INCRBY', tokenKey, reserved)
  end
end
redis.call('HSET', resvKey, 'state', 'released')
redis.call('EXPIRE', resvKey, 900)
redis.call('RPUSH', journalKey, cjson.encode({rid=ARGV[1], uid=ARGV[2], tid=ARGV[3], amount=0, reserved=reserved, kind='release'}))
redis.call('EXPIRE', journalKey, tonumber(ARGV[4]))
return {1, reserved}
`

/**
 * Picks the next key from a channel's key pool, skipping keys marked bad.
 * KEYS[1] index counter
 * ARGV[1] pool size
 * -> chosen index
 */
export const NEXT_KEY_LUA = `
local size = tonumber(ARGV[1])
if size <= 0 then return -1 end
local n = redis.call('INCR', KEYS[1])
redis.call('EXPIRE', KEYS[1], 86400)
return (n - 1) % size
`

/**
 * Records a channel outcome and trips the breaker when the failure threshold
 * is reached inside the observation window.
 * KEYS[1] health hash
 * ARGV[1] ok(0|1), ARGV[2] threshold, ARGV[3] cooldown-sec, ARGV[4] now-ms
 * -> {state, fails}  state: 0 closed, 1 open
 */
export const HEALTH_LUA = `
local key = KEYS[1]
local ok = tonumber(ARGV[1])
local threshold = tonumber(ARGV[2])
local cooldown = tonumber(ARGV[3])
local now = tonumber(ARGV[4])
if ok == 1 then
  redis.call('HSET', key, 'fails', 0, 'openUntil', 0)
  redis.call('EXPIRE', key, cooldown * 10)
  return {0, 0}
end
local fails = tonumber(redis.call('HINCRBY', key, 'fails', 1))
local state = 0
if fails >= threshold then
  redis.call('HSET', key, 'openUntil', now + cooldown * 1000)
  state = 1
end
redis.call('EXPIRE', key, cooldown * 10)
return {state, fails}
`

export const SCRIPTS = {
	tokenBucket: TOKEN_BUCKET_LUA,
	fixedWindow: FIXED_WINDOW_LUA,
	slidingSuccess: SLIDING_SUCCESS_LUA,
	reserve: RESERVE_LUA,
	settle: SETTLE_LUA,
	release: RELEASE_LUA,
	nextKey: NEXT_KEY_LUA,
	health: HEALTH_LUA,
} as const

export type ScriptName = keyof typeof SCRIPTS
