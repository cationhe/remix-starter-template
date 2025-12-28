import type { MetaFunction } from "@remix-run/cloudflare";

export const meta: MetaFunction = () => {
	return [
		{ title: "AI传感器编程学习论坛" },
		{ name: "description", content: "AI传感器编程学习论坛" },
	];
};

export default function Index() {
	return (
		<div className="flex min-h-screen items-center justify-center px-6">
			<div className="w-full max-w-md rounded-2xl bg-white/80 backdrop-blur-md p-10 shadow-xl ring-1 ring-slate-900/5 dark:bg-slate-900/80 dark:ring-slate-100/10 transition-all">
				<h1 className="text-center text-3xl font-bold text-slate-900 dark:text-white">
					AI传感器编程学习论坛
				</h1>
				<nav className="mt-10 flex flex-col gap-4">
					<a
						href="/posts"
						className="rounded-lg bg-blue-600 px-6 py-3 text-center text-base font-medium text-white shadow-lg shadow-blue-600/30 transition-all hover:bg-blue-700 hover:shadow-blue-600/40 hover:-translate-y-0.5 active:translate-y-0"
					>
						进入论坛
					</a>
				</nav>
			</div>
		</div>
	);
}
