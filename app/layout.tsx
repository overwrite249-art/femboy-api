import type { ReactNode } from "react"
import localFont from "next/font/local"

import "./globals.css"
import "./cozy.css"
import { InterfaceProvider } from "./components/interface.tsx"

/**
 * Every family is SIL OFL 1.1 and self-hosted, so the browser makes no
 * third-party font request. Nunito carries body copy and the console UI,
 * Young Serif sets display type, Caveat is reserved for short handwritten
 * notes, and IBM Plex Mono stays on anything a reader would copy.
 */
const sans = localFont({
	src: "../public/fonts/nunito-var-latin.woff2",
	weight: "300 900",
	style: "normal",
	display: "swap",
	variable: "--font-gateway-sans",
	fallback: ["ui-rounded", "Helvetica Neue", "Arial", "sans-serif"],
})
const display = localFont({
	src: "../public/fonts/young-serif-400-latin.woff2",
	weight: "400",
	display: "swap",
	variable: "--font-gateway-display",
	fallback: ["Georgia", "Times New Roman", "serif"],
})
const hand = localFont({
	src: "../public/fonts/caveat-var-latin.woff2",
	weight: "500 700",
	display: "swap",
	variable: "--font-gateway-hand",
	fallback: ["Segoe Print", "Bradley Hand", "cursive"],
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

export const viewport = {
	themeColor: "#ff5a78",
}

export default function RootLayout(props: { children: ReactNode }) {
	return (
		<html
			lang="en"
			className={`${sans.variable} ${display.variable} ${hand.variable} ${mono.variable}`}
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
