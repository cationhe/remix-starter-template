import { test, expect } from "@playwright/test";
import { validateAttachmentMeta, assertArchiveContentsSafe } from "../../app/lib/attachments.server";

function buildZipWithNames(names: string[]) {
  const encoder = new TextEncoder();
  const entries: Uint8Array[] = [];
  let cdSize = 0;
  let cdOffset = 0;
  for (const name of names) {
    const nameBytes = encoder.encode(name);
    const header = new Uint8Array(46);
    // Central directory file header signature 0x02014b50
    header[0] = 0x50; header[1] = 0x4b; header[2] = 0x01; header[3] = 0x02;
    // version / flags / method / time / date etc left zero
    // CRC, sizes left zero
    // file name length
    header[28] = nameBytes.length & 0xff;
    header[29] = (nameBytes.length >> 8) & 0xff;
    // extra/comment length zero
    // relative offset of local header zero
    const entry = new Uint8Array(header.length + nameBytes.length);
    entry.set(header, 0);
    entry.set(nameBytes, header.length);
    entries.push(entry);
    cdSize += entry.length;
  }
  // EOCD
  const eocd = new Uint8Array(22);
  eocd[0] = 0x50; eocd[1] = 0x4b; eocd[2] = 0x05; eocd[3] = 0x06; // 0x06054b50
  // total entries
  const count = names.length;
  eocd[10] = count & 0xff;
  eocd[11] = (count >> 8) & 0xff;
  eocd[8] = eocd[10];
  eocd[9] = eocd[11];
  // size of central directory
  eocd[12] = cdSize & 0xff;
  eocd[13] = (cdSize >> 8) & 0xff;
  eocd[14] = (cdSize >> 16) & 0xff;
  eocd[15] = (cdSize >> 24) & 0xff;
  // offset of central directory
  eocd[16] = cdOffset & 0xff;
  eocd[17] = (cdOffset >> 8) & 0xff;
  eocd[18] = (cdOffset >> 16) & 0xff;
  eocd[19] = (cdOffset >> 24) & 0xff;
  // comment length zero
  const all = new Uint8Array(cdSize + eocd.length);
  let ptr = 0;
  for (const ent of entries) { all.set(ent, ptr); ptr += ent.length; }
  all.set(eocd, ptr);
  return all;
}

test("普通用户扩展名白名单与无扩展名拒绝", () => {
  const ok = validateAttachmentMeta({ filename: "report.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", sizeBytes: 1024 * 1024 }, { isSuperadmin: false });
  expect(ok).toBeNull();
  const ok2 = validateAttachmentMeta({ filename: "video.MP4", mimeType: "video/mp4", sizeBytes: 3 * 1024 * 1024 }, { isSuperadmin: false });
  expect(ok2).toBeNull();
  const badExt = validateAttachmentMeta({ filename: "image.png", mimeType: "image/png", sizeBytes: 1024 * 1024 }, { isSuperadmin: false });
  expect(badExt).toBe("不支持的文件类型");
  const noExt = validateAttachmentMeta({ filename: "noext", mimeType: "application/octet-stream", sizeBytes: 1024 * 1024 }, { isSuperadmin: false });
  expect(noExt).toBe("不支持的文件类型");
});

test("超管允许任意扩展名但遵循大小上限", () => {
  const ok = validateAttachmentMeta({ filename: "tool.exe", mimeType: "application/octet-stream", sizeBytes: 1024 * 1024 }, { isSuperadmin: true });
  expect(ok).toBeNull();
  const tooLarge = validateAttachmentMeta({ filename: "tool.exe", mimeType: "application/octet-stream", sizeBytes: 101 * 1024 * 1024 }, { isSuperadmin: true });
  expect(tooLarge).toBe("文件大小需在 1KB 到 100MB 之间");
});

test("压缩包内容检查：zip 中包含危险扩展名被拒绝", () => {
  const zip = buildZipWithNames(["evil.js", "readme.txt"]);
  const message = assertArchiveContentsSafe(zip, "zip");
  expect(message).toBe("压缩包内包含不安全文件类型");
  const zip2 = buildZipWithNames(["safe.docx"]);
  const message2 = assertArchiveContentsSafe(zip2, "zip");
  expect(message2).toBeNull();
});
