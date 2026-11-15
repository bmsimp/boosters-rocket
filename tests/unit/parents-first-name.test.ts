import { describe, it, expect } from "vitest";
import { firstName } from "@/lib/parents/first-name";

describe("firstName: who to greet, from a name as QuickBooks holds it", () => {
  it.each([
    ["Ana Rivera", "Ana"],
    ["Rivera, Ana", "Ana"],
    ["Rivera,Ana", "Ana"],
    ["Rivera, Ana Maria", "Ana"],
    ["  Ana   Rivera  ", "Ana"],
    ["Ana", "Ana"],
    ["Ana Rivera, Jr.", "Ana"],
    ["Ana Rivera, III", "Ana"],
    ["Mary-Jane O'Neil", "Mary-Jane"],
    ["D'Arcy Lee", "D'Arcy"],
    ["José Álvarez", "José"],
    ["Álvarez, José", "José"],
    ["Andy Rand", "Andy"], // "and" inside a word is not a couple
    ["Zelda Quetzalcoatl", "Zelda"],
  ])("%j is greeted as %j", (name, first) => {
    expect(firstName(name)).toBe(first);
  });

  it.each([
    ["", "nothing"],
    ["   ", "only spaces"],
    ["Rivera Family", "a household"],
    ["The Riveras", "a household"],
    ["Rivera Household", "a household"],
    ["Ana & Bob Rivera", "a couple"],
    ["Ana and Bob Rivera", "a couple"],
    ["Rivera, Ana and Bob", "a couple"],
    ["Dr. Ana Rivera", "a title first"],
    ["Mrs Rivera", "a title first"],
    ["A. Rivera", "an initial"],
    ["J Rivera", "an initial"],
    ["Rivera, A.", "an initial"],
    ["Rivera,", "nothing after the comma"],
    [", Ana", "nothing before the comma, which may not be a name at all"],
    ["Rivera, Ana, Jr.", "more than one comma"],
    ["ana@example.com", "an email address"],
    ["Ana Rivera (mom)", "something written into the name"],
    ["Rivera 2", "a number"],
    ["Rivera/Okafor", "two names"],
    ["<img src=x onerror=alert(1)>", "markup"],
  ])("%j gets no name (%s)", (name) => {
    expect(firstName(name)).toBeNull();
  });
});
