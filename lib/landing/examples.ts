/** Public request templates. Never accept, store or embed a user's API key. */
export function landingExamples(inputOrigin: string) {
  const url = new URL(inputOrigin);
  if (url.protocol !== "https:" && url.protocol !== "http:")
    throw new TypeError("Examples require an HTTP or HTTPS gateway origin");
  // Discard credentials, paths, queries and fragments before generating code.
  const origin = url.origin;
  const endpoint = `${origin}/v1/chat/completions`;
  const base = JSON.stringify(`${origin}/v1`);
  const shellEndpoint = endpoint.replaceAll("'", "'\\''");
  return {
    JavaScript: `import OpenAI from "openai";

const client = new OpenAI({
  baseURL: ${base},
  apiKey: process.env.FEMBOY_API_KEY,
});

const reply = await client.chat.completions.create({
  model: "YOUR_MODEL",
  messages: [{ role: "user", content: "Hello, world!" }],
  max_tokens: 128,
});

console.log(reply.choices[0].message.content);`,
    Python: `import os
from openai import OpenAI

client = OpenAI(
    base_url=${base},
    api_key=os.environ["FEMBOY_API_KEY"],
)

reply = client.chat.completions.create(
    model="YOUR_MODEL",
    messages=[{"role": "user", "content": "Hello, world!"}],
    max_tokens=128,
)

print(reply.choices[0].message.content)`,
    cURL: `curl '${shellEndpoint}' \\
  -H "Authorization: Bearer $FEMBOY_API_KEY" \\
  -H 'Content-Type: application/json' \\
  -d '{
    "model": "YOUR_MODEL",
    "messages": [
      {"role": "user", "content": "Hello, world!"}
    ],
    "max_tokens": 128,
    "stream": false
  }'`,
  };
}
