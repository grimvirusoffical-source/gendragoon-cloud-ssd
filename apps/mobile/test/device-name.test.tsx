import { Platform } from "react-native";
import * as Device from "expo-device";
import { mobileDeviceName } from "../src/teams";

describe("mobile chat name default (expo-device)", () => {
  const os = Platform.OS;
  afterEach(() => { Object.defineProperty(Platform, "OS", { value: os, configurable: true }); });
  const as = (value: string) => Object.defineProperty(Platform, "OS", { value, configurable: true });

  it("uses the device's own name first", () => {
    as("android");
    expect(mobileDeviceName({ deviceName: "Josh's Pixel", modelName: "Pixel 9", manufacturer: "Google" })).toBe("Josh's Pixel");
  });
  it("falls back to the model when there is no name, with the maker on Android", () => {
    as("android");
    expect(mobileDeviceName({ deviceName: null, modelName: "Pixel 9", manufacturer: "Google" })).toBe("Google Pixel 9");
    expect(mobileDeviceName({ deviceName: "", modelName: "SM-S928B", manufacturer: "samsung" })).toBe("samsung SM-S928B");
    expect(mobileDeviceName({ deviceName: null, modelName: "Galaxy S24", manufacturer: "Galaxy" })).toBe("Galaxy S24");
  });
  it("treats iOS's generic \"iPhone\" as no name and uses the model", () => {
    as("ios");
    expect(mobileDeviceName({ deviceName: "iPhone", modelName: "iPhone 16 Pro", manufacturer: "Apple" })).toBe("iPhone 16 Pro");
    expect(mobileDeviceName({ deviceName: "Josh's iPad", modelName: "iPad Air", manufacturer: "Apple" })).toBe("Josh's iPad");
    expect(mobileDeviceName({ deviceName: "iPad", modelName: null })).toBe("iPad");
  });
  it("trims to 40 characters and never returns an empty name", () => {
    expect(mobileDeviceName({ deviceName: "x".repeat(60) })).toHaveLength(40);
    as("web");
    expect(mobileDeviceName({})).toBe("Member");
  });
  it("defaults to the real expo-device module", () => {
    expect(typeof Device.deviceName === "string" || Device.deviceName === null || Device.deviceName === undefined).toBe(true);
    expect(typeof mobileDeviceName()).toBe("string");
  });
});
