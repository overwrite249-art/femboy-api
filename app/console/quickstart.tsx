"use client"
import { useEffect, useState } from "react"
import { Terminal } from "lucide-react"
import { CopyButton } from "../components/interface.tsx"
import { curlExample } from "../../lib/console/client-utils.ts"
export function useOrigin() {
	const [origin, setOrigin] = useState("https://your-gateway.example")
	useEffect(() => {
		setOrigin(window.location.origin)
	}, [])
	return origin
}
export function Quickstart({ model = "YOUR_MODEL" }: { model?: string }) {
	const [language, setLanguage] = useState("cURL")
	const origin = useOrigin()
	const body = {
		model,
		messages: [{ role: "user", content: "Hello!" }],
		max_tokens: 128,
		stream: false,
	}
	const examples: Record<string, string> = {
		cURL: curlExample(origin, body),
		JavaScript: `import OpenAI from "openai";\n\nconst client = new OpenAI({\n  baseURL: "${origin}/v1",\n  apiKey: process.env.FEMBOY_API_KEY,\n});\n\nconst response = await client.chat.completions.create({\n  model: "${model}",\n  messages: [{ role: "user", content: "Hello!" }],\n  max_tokens: 128,\n});\nconsole.log(response.choices[0].message.content);`,
		Python: `import os\nfrom openai import OpenAI\n\nclient = OpenAI(\n    base_url="${origin}/v1",\n    api_key=os.environ["FEMBOY_API_KEY"],\n)\n\nresponse = client.chat.completions.create(\n    model="${model}",\n    messages=[{"role": "user", "content": "Hello!"}],\n    max_tokens=128,\n)\nprint(response.choices[0].message.content)`,
	}
	return (
		<div className="code-window">
			<div className="code-window-head">
				<div className="code-tabs" role="group" aria-label="Example language">
					{Object.keys(examples).map((name) => (
						<button
							key={name}
							className={language === name ? "active" : ""}
							type="button"
							aria-pressed={language === name}
							onClick={() => setLanguage(name)}
						>
							{name}
						</button>
					))}
				</div>
				<CopyButton value={examples[language]} label="Copy example" iconOnly />
			</div>
			<pre className="code">
				<code>{examples[language]}</code>
			</pre>
			<div className="code-window-foot">
				<Terminal size={14} />
				Set FEMBOY_API_KEY in your shell. Replace YOUR_MODEL with a configured
				model.
			</div>
		</div>
	)
}
