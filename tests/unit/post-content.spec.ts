import { test, expect } from "@playwright/test";
import { extractPostContentImageIds, splitPostContentParts } from "../../app/lib/post-content";

test("插图语法：纯文本不应被拆分", () => {
	const parts = splitPostContentParts("hello\nworld");
	expect(parts).toEqual([{ type: "text", text: "hello\nworld" }]);
});

test("插图语法：应识别 [[img:1]]", () => {
	const parts = splitPostContentParts("a[[img:1]]b");
	expect(parts).toEqual([
		{ type: "text", text: "a" },
		{ type: "image", imageId: 1 },
		{ type: "text", text: "b" },
	]);
});

test("插图语法：非法 id 应保留为文本", () => {
	const parts = splitPostContentParts("[[img:0]][[img:abc]]");
	expect(parts).toEqual([
		{ type: "text", text: "[[img:0]]" },
		{ type: "text", text: "[[img:abc]]" },
	]);
});

test("提取插图ID：应返回去重后的正整数列表", () => {
	const ids = extractPostContentImageIds("a[[img:2]]b[[img:2]][[img:5]]");
	expect(ids).toEqual([2, 5]);
});

test("提取插图ID：非法 id 不应被提取", () => {
	const ids = extractPostContentImageIds("[[img:0]][[img:-1]][[img:abc]]");
	expect(ids).toEqual([]);
});
