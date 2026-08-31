import type { ReactNode } from "react"

import "./globals.css"

export const metadata = {
	title: "femboy api",
	description:
		"A self-hosted AI gateway that speaks OpenAI, Anthropic and Gemini over one key.",
}

export default function RootLayout(props: { children: ReactNode }) {
	return (
		<html lang="en">
			<body>{props.children}</body>
		</html>
	)
}
