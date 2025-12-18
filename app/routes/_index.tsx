import type { MetaFunction } from "@remix-run/cloudflare";

export const meta: MetaFunction = () => {
	return [
		{ title: "AI传感器编程学习论坛" },
		{ name: "description", content: "AI传感器编程学习论坛" },
	];
};

export default function Index() {
	return (
		<div className="flex min-h-screen items-center justify-center bg-white px-6">
			<div className="w-full max-w-md">
				<h1 className="text-center text-2xl font-semibold text-gray-900">
					AI传感器编程学习论坛
				</h1>
				<nav className="mt-8 flex flex-col gap-3">
					<a
						href="/posts"
						className="rounded bg-gray-900 px-4 py-2 text-center text-sm font-medium text-white hover:bg-gray-800"
					>
						进入论坛
					</a>
				</nav>
			</div>
		</div>
	);
}
