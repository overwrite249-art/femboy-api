import type { ReactNode } from "react"
import localFont from "next/font/local"

import "./globals.css"
import { InterfaceProvider } from "./components/interface.tsx"

const sans = localFont({
	src: "../public/fonts/ibm-plex-sans-400-latin.woff2",
	weight: "400 600",
	display: "swap",
	variable: "--font-gateway-sans",
	fallback: ["Arial", "sans-serif"],
})
const mono = localFont({
	src: "../public/fonts/ibm-plex-mono-400-latin.woff2",
	weight: "400",
	display: "swap",
	variable: "--font-gateway-mono",
	fallback: ["Consolas", "monospace"],
})

export const metadata = {
	title: "femboy api",
	description:
		"A self-hosted AI gateway that speaks OpenAI, Anthropic and Gemini over one key.",
}

export default function RootLayout(props: { children: ReactNode }) {
	return (
		<html
			lang="en"
			className={`${sans.variable} ${mono.variable}`}
			suppressHydrationWarning
		>
			<head>
				<script
					dangerouslySetInnerHTML={{
						__html: `try{var t=localStorage.getItem('femboy-ui-theme');document.documentElement.dataset.theme=t==='light'||t==='dark'?t:'system'}catch(e){}`,
					}}
				/>
			</head>
			<body>
				<InterfaceProvider>{props.children}</InterfaceProvider>
			</body>
		</html>
	)
}
