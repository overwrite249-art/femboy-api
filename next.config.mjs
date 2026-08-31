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
	/**
	 * Clients configured with `base_url = https://host/v1` must reach the same
	 * handlers as `/api/v1`. Every route parser reads path segments by name
	 * rather than by index, so it does not matter which form arrives.
	 */
	async rewrites() {
		return [
			{ source: "/v1/:path*", destination: "/api/v1/:path*" },
			{ source: "/v1beta/:path*", destination: "/api/v1beta/:path*" },
			{ source: "/mj/:path*", destination: "/api/mj/:path*" },
			{ source: "/suno/:path*", destination: "/api/suno/:path*" },
			{ source: "/kling/:path*", destination: "/api/kling/:path*" },
			{ source: "/jimeng/:path*", destination: "/api/jimeng/:path*" },
			{ source: "/vidu/:path*", destination: "/api/vidu/:path*" },
			{ source: "/dify/:path*", destination: "/api/dify/:path*" },
		]
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
