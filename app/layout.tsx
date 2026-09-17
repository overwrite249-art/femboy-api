import type { ReactNode } from "react"
import localFont from "next/font/local"

import "./globals.css"
import { InterfaceProvider } from "./components/interface.tsx"

/**
 * Archivo (SIL OFL 1.1) is a variable grotesque with weight and width axes.
 * The landing page drives both axes for display type; the console uses the
 * normal width. Self-hosted, so the browser makes no third-party font request.
 */
const sans = localFont({
	src: "../public/fonts/archivo-var-latin.woff2",
	weight: "100 900",
	style: "normal",
	display: "swap",
	variable: "--font-gateway-sans",
	fallback: ["Helvetica Neue", "Arial", "sans-serif"],
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
