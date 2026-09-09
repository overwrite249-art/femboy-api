"use client"

import {
	createContext,
	useCallback,
	useContext,
	useEffect,
	useId,
	useRef,
	useState,
} from "react"
import type { ReactNode } from "react"
import {
	Check,
	CheckCircle2,
	Copy,
	Monitor,
	Moon,
	ShieldAlert,
	Sun,
	X,
} from "lucide-react"

type Theme = "system" | "light" | "dark"
const ThemeContext = createContext<{
	theme: Theme
	setTheme: (theme: Theme) => void
}>({ theme: "system", setTheme: () => {} })
const ToastContext = createContext<(message: string) => void>(() => {})
type Confirmation = {
	title: string
	description: string
	action?: string
	danger?: boolean
}
const ConfirmContext = createContext<
	(options: Confirmation) => Promise<boolean>
>(async () => false)

export function InterfaceProvider({ children }: { children: ReactNode }) {
	const [theme, updateTheme] = useState<Theme>("system")
	const [toast, setToast] = useState("")
	const [confirmation, setConfirmation] = useState<Confirmation | null>(null)
	const resolveRef = useRef<((answer: boolean) => void) | null>(null)
	const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
	useEffect(() => {
		try {
			const saved = localStorage.getItem("femboy-ui-theme")
			if (saved === "light" || saved === "dark") updateTheme(saved)
		} catch {
			/* UI preferences are optional. */
		}
		return () => {
			if (timer.current) clearTimeout(timer.current)
			resolveRef.current?.(false)
		}
	}, [])
	const setTheme = useCallback((value: Theme) => {
		updateTheme(value)
		document.documentElement.dataset.theme = value
		try {
			localStorage.setItem("femboy-ui-theme", value)
		} catch {
			/* Private mode may block storage. */
		}
	}, [])
	const notify = useCallback((message: string) => {
		if (timer.current) clearTimeout(timer.current)
		setToast(message)
		timer.current = setTimeout(() => setToast(""), 4500)
	}, [])
	const confirm = useCallback(
		(options: Confirmation) =>
			new Promise<boolean>((resolve) => {
				resolveRef.current?.(false)
				resolveRef.current = resolve
				setConfirmation(options)
			}),
		[],
	)
	function answer(value: boolean) {
		resolveRef.current?.(value)
		resolveRef.current = null
		setConfirmation(null)
	}
	return (
		<ThemeContext.Provider value={{ theme, setTheme }}>
			<ToastContext.Provider value={notify}>
				<ConfirmContext.Provider value={confirm}>
					{children}
					<div className="toast-region" role="status" aria-live="polite">
						{toast ? (
							<div className="toast">
								<CheckCircle2 size={18} />
								<span>{toast}</span>
								<button
									type="button"
									className="icon-btn"
									aria-label="Dismiss notification"
									onClick={() => setToast("")}
								>
									<X size={16} />
								</button>
							</div>
						) : null}
					</div>
					<Dialog
						open={Boolean(confirmation)}
						title={confirmation?.title ?? "Confirm action"}
						onClose={() => answer(false)}
					>
						<div
							className={
								"dialog-symbol" + (confirmation?.danger ? " danger" : "")
							}
						>
							<ShieldAlert size={24} />
						</div>
						<p className="dialog-copy">{confirmation?.description}</p>
						<div className="dialog-actions">
							<button
								className="btn"
								type="button"
								autoFocus
								onClick={() => answer(false)}
							>
								Cancel
							</button>
							<button
								className={
									"btn " +
									(confirmation?.danger ? "btn-danger-solid" : "btn-primary")
								}
								type="button"
								onClick={() => answer(true)}
							>
								{confirmation?.action ?? "Confirm"}
							</button>
						</div>
					</Dialog>
				</ConfirmContext.Provider>
			</ToastContext.Provider>
		</ThemeContext.Provider>
	)
}
export const useToast = () => useContext(ToastContext)
export const useConfirm = () => useContext(ConfirmContext)

export function Brand({ compact = false }: { compact?: boolean }) {
	return (
		<span className="brand">
			<span className="brand-mark" aria-hidden="true">
				f/
			</span>
			{!compact ? (
				<span>
					<span className="brand-name">
						femboy<span className="brand-api"> / api</span>
					</span>
				</span>
			) : null}
		</span>
	)
}

export function ThemePicker() {
	const { theme, setTheme } = useContext(ThemeContext)
	return (
		<div className="theme-picker" role="group" aria-label="Color theme">
			{(
				[
					["light", Sun, "Light theme"],
					["dark", Moon, "Dark theme"],
					["system", Monitor, "System theme"],
				] as const
			).map(([value, Icon, label]) => (
				<button
					key={value}
					className={theme === value ? "selected" : ""}
					type="button"
					aria-label={label}
					aria-pressed={theme === value}
					title={label}
					onClick={() => setTheme(value)}
				>
					<Icon size={17} />
				</button>
			))}
		</div>
	)
}

export function CopyButton({
	value,
	label = "Copy",
	iconOnly = false,
}: {
	value: string
	label?: string
	iconOnly?: boolean
}) {
	const [copied, setCopied] = useState(false)
	const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
	const notify = useToast()
	useEffect(
		() => () => {
			if (timer.current) clearTimeout(timer.current)
		},
		[],
	)
	async function copy() {
		try {
			await navigator.clipboard.writeText(value)
			setCopied(true)
			if (timer.current) clearTimeout(timer.current)
			timer.current = setTimeout(() => setCopied(false), 2200)
		} catch {
			notify(
				"Clipboard access was blocked. Select the text and copy it manually.",
			)
		}
	}
	return (
		<button
			type="button"
			className={iconOnly ? "icon-btn" : "btn btn-small"}
			onClick={copy}
			aria-label={copied ? "Copied" : label}
			title={copied ? "Copied" : label}
		>
			{copied ? <Check size={16} /> : <Copy size={16} />}
			{!iconOnly ? (copied ? "Copied" : label) : null}
		</button>
	)
}

export function Dialog({
	open,
	title,
	onClose,
	children,
	className = "",
}: {
	open: boolean
	title: string
	onClose: () => void
	children: ReactNode
	className?: string
}) {
	const ref = useRef<HTMLDialogElement>(null)
	const titleId = useId()
	useEffect(() => {
		const dialog = ref.current
		if (!dialog) return
		if (open && !dialog.open) dialog.showModal()
		if (!open && dialog.open) dialog.close()
	}, [open])
	return (
		<dialog
			ref={ref}
			className={"dialog " + className}
			aria-labelledby={titleId}
			onCancel={(event) => {
				event.preventDefault()
				onClose()
			}}
			onClick={(event) => {
				if (event.target === event.currentTarget) {
					const box = event.currentTarget.getBoundingClientRect()
					if (
						event.clientX < box.left ||
						event.clientX > box.right ||
						event.clientY < box.top ||
						event.clientY > box.bottom
					)
						onClose()
				}
			}}
		>
			<div className="dialog-head">
				<h2 id={titleId}>{title}</h2>
				<button
					type="button"
					className="icon-btn"
					aria-label="Close dialog"
					onClick={onClose}
				>
					<X size={20} />
				</button>
			</div>
			{children}
		</dialog>
	)
}
