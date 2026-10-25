import { afterEach, describe, expect, test } from "bun:test";
import { testRender } from "@opentui/solid";
import { animationOff, Orb } from "./orb.tsx";

type Setup = Awaited<ReturnType<typeof testRender>>;
let setup: Setup | undefined;
afterEach(async () => {
  await setup?.dispose();
  setup = undefined;
});

const BRAILLE = /[⠁-⣿]/;

async function frameOf(seconds: number | undefined) {
  setup = await testRender(
    () => <Orb state="searching" {...(seconds === undefined ? {} : { seconds })} />,
    { width: 8, height: 3 },
  );
  await setup.renderOnce();
  const frame = setup.captureCharFrame();
  await setup.dispose();
  setup = undefined;
  return frame;
}

describe("orb (headless)", () => {
  test("draws braille in a 4 × 2 cell block, and moves with time", async () => {
    const a = await frameOf(0.4);
    const lines = a.split("\n");
    expect(lines[0]).toMatch(BRAILLE);
    expect(lines[1]).toMatch(BRAILLE);
    expect(lines[0]?.trimEnd().length).toBeLessThanOrEqual(4);
    expect(lines[2]?.trim()).toBe("");
    expect(await frameOf(0.9)).not.toBe(a);
  });

  test("without a time it is one still frame", async () => {
    expect(await frameOf(undefined)).toBe(await frameOf(undefined));
    expect(await frameOf(undefined)).toMatch(BRAILLE);
  });

  test("HAMNESS_NO_ANIMATION=1 turns the motion off", () => {
    expect(animationOff({ HAMNESS_NO_ANIMATION: "1" })).toBe(true);
    expect(animationOff({ HAMNESS_NO_ANIMATION: "0" })).toBe(false);
    expect(animationOff({})).toBe(false);
  });
});
