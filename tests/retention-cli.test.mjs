import { afterEach, describe, expect, it, vi } from "vitest";
const open = vi.hoisted(() => vi.fn());
vi.mock("node:fs/promises", () => ({ open, writeFile: vi.fn() }));
import { readLocalInventory } from "../scripts/retention-dry-run.mjs";
afterEach(() => vi.clearAllMocks());
function handle(bytes, statSize = bytes.length) {
  return { stat: vi.fn(async () => ({ isFile: () => true, size: statSize })),
    read: vi.fn(async (buffer, offset, length, position) => {
      const count = Math.min(length, Math.max(0, bytes.length - position));
      buffer.set(bytes.subarray(position, position + count), offset); return { bytesRead: count };
    }), close: vi.fn(async () => {}) };
}
describe("retention local CLI input ceiling", () => {
  it("bounds file growth after stat and closes the opened handle", async () => {
    const file = handle(Buffer.alloc(2_000_002, 32), 10); open.mockResolvedValue(file);
    await expect(readLocalInventory("synthetic-local.json")).rejects.toThrow("invalid_inventory_file_size");
    expect(file.read).toHaveBeenCalledTimes(1);
    expect(file.read.mock.calls[0][2]).toBe(2_000_001);
    expect(file.close).toHaveBeenCalledTimes(1);
  });
  it("reads valid input only through the original opened handle", async () => {
    const file = handle(Buffer.from('{"synthetic":true}')); open.mockResolvedValue(file);
    expect((await readLocalInventory("synthetic-local.json")).toString()).toBe('{"synthetic":true}');
    expect(open).toHaveBeenCalledTimes(1); expect(file.close).toHaveBeenCalledTimes(1);
  });
  it("rejects initial oversize without a data read and closes the handle", async () => {
    const file = handle(Buffer.alloc(1), 2_000_001); open.mockResolvedValue(file);
    await expect(readLocalInventory("synthetic-local.json")).rejects.toThrow();
    expect(file.read).not.toHaveBeenCalled(); expect(file.close).toHaveBeenCalledTimes(1);
  });
  it("closes a failed reader rather than leaking the file handle", async () => {
    const file = handle(Buffer.from("{}")); file.read.mockRejectedValue(new Error("synthetic-read-failure")); open.mockResolvedValue(file);
    await expect(readLocalInventory("synthetic-local.json")).rejects.toThrow("synthetic-read-failure");
    expect(file.close).toHaveBeenCalledTimes(1);
  });
});
