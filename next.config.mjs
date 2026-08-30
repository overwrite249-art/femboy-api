/** @type {import('next').NextConfig} */
const nextConfig = {
	reactStrictMode: true,
	poweredByHeader: false,
	logging: {
		fetches: { fullUrl: false },
	},
	experimental: {
		// The relay streams for a long time; keep the proxy from buffering.
		proxyTimeout: 300_000,
	},
	// The gateway is an API surface first. Every response gets hardened headers;
	// the relay routes additionally strip/override these in code (see lib/http/headers.ts).
	async headers() {
		return [
			{
				source: "/:path*",
				headers: [
					{ key: "X-Content-Type-Options", value: "nosniff" },
					{ key: "X-Frame-Options", value: "DENY" },
					{ key: "Referrer-Policy", value: "no-referrer" },
					{
						key: "Strict-Transport-Security",
						value: "max-age=63072000; includeSubDomains; preload",
					},
					{ key: "Cross-Origin-Opener-Policy", value: "same-origin" },
					{ key: "X-Robots-Tag", value: "noindex, nofollow" },
				],
			},
		]
	},
}

export default nextConfig
