import { Doc } from "../Doc.js";
import { YMap } from "../YMap.js";

describe("Doc", () => {
  it("should handle nested maps", () => {
    const doc = new Doc();
    const root = doc.getMap();
    const userMap = root.getMap("user");
    userMap.set("name", "David");

    const expected = {
      user: {
        crdtType: "YMap",
        data: { name: "David" },
      },
    };
    expect(doc.toJSON()).toEqual(expected);
  });

  it("should apply updates to nested maps", () => {
    const doc = new Doc();
    const root = doc.getMap();
    // Ensure the user map exists before applying an update to it.
    // In a real scenario, this might be created by another user or a previous operation.
    root.getMap("user");

    const update = {
      path: ["user"],
      payload: {
        type: "set",
        key: "name",
        value: "David",
      },
    };

    doc.applyUpdate(update);

    const userMap = doc.getMap().get("user") as YMap;
    expect(userMap.get("name")).toEqual("David");
  });
});
