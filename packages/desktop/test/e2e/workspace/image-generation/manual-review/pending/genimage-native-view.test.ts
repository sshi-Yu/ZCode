const workspace = '[data-testid="genimage-workspace"]';
const entry = '[data-testid="genimage-sidebar-open"]';
const node = (id: string) => `${workspace} [data-genimage-node="${id}"]`;

describe("GENIMAGE-VIEW native canvas", () => {
  it("opens the fixture without a plugin and derives one child without changing its source", async () => {
    await $(entry).waitForClickable({ timeout: 30000 });
    await $(entry).click();
    await $(workspace).waitForDisplayed();
    expect(await $(entry).getAttribute("aria-pressed")).toBe("true");
    expect(await $$("[data-genimage-node]").length).toBe(3);
    expect(await $(node("B")).getAttribute("data-source")).toBe("A");
    expect(await $(node("C")).getAttribute("data-source")).toBe("A");

    const sourceTitle = await $(`${node("B")} h3`).getText();
    await $(`${node("B")} [data-testid="genimage-derive"]`).click();
    await $("[data-testid='genimage-prompt']").setValue("GENIMAGE_VIEW local child");
    await $("[data-testid='genimage-submit']").click();
    await $(node("D")).waitForExist();
    expect(await $(node("D")).getAttribute("data-source")).toBe("B");
    expect(await $(`${node("B")} h3`).getText()).toBe(sourceTitle);
    expect(await $(node("B")).getAttribute("data-source")).toBe("A");
    expect(await $$("[data-genimage-node]").length).toBe(4);

    await $("[data-testid='genimage-history']").click();
    await $("[data-genimage-history='A']").click();
    expect(await $(node("A")).getAttribute("data-selected")).toBe("true");

    await $('[data-testid="desktop-top-nav-back"]').click();
    await $(workspace).waitForExist({ reverse: true });
    await $(entry).click();
    await $(node("A")).waitForDisplayed();
    expect(await $$("[data-genimage-node]").length).toBe(3);
  });
});
