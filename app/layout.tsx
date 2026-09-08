import type { ReactNode } from "react"

import "./globals.css"
import { InterfaceProvider } from "./components/interface.tsx"

export const metadata = {
	title: "femboy api",
	description:
		"A self-hosted AI gateway that speaks OpenAI, Anthropic and Gemini over one key.",
}

export default function RootLayout(props: { children: ReactNode }) {
	return (
		<html lang="en" suppressHydrationWarning>
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
