import { test, expect } from "bun:test";
import { installedAdvertise } from "./cli-entry";

const plist = (keyDir: string) =>
  `<key>POCKETSHELL_KEY_DIR</key><string>${keyDir}</string>` +
  `<key>POCKETSHELL_ADVERTISE</key><string>wss://box.ts.net:8443</string>`;
const systemd = (keyDir: string) =>
  `Environment=POCKETSHELL_KEY_DIR=${keyDir}\nEnvironment=POCKETSHELL_ADVERTISE=wss://box.ts.net:8443\n`;
const unit = process.platform === "darwin" ? plist : systemd;

test("pair takes the advertise address from the service unit for the same keyDir", () => {
  expect(installedAdvertise("/k", () => unit("/k"))).toBe("wss://box.ts.net:8443");
});

test("pair ignores a unit that serves another keyDir", () => {
  expect(installedAdvertise("/k", () => unit("/other"))).toBeNull();
});

test("pair falls back when no unit is installed", () => {
  expect(installedAdvertise("/k", () => { throw new Error("ENOENT"); })).toBeNull();
});
