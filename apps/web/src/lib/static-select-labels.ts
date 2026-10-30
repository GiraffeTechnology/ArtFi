import { isTranslatableSource } from "./language";

export const staticSelectMutationAttributes = [
  "label",
  "value",
  "data-translate-options",
  "data-no-translate",
  "data-translation-skip",
] as const;

type Record = {
  originalLabel: string | null;
  originalText: string;
  value: string;
  select: HTMLSelectElement | null;
  writtenLabel: string | null;
  written: boolean;
};
export type StaticSelectLabel = Readonly<{
  element: HTMLOptionElement;
  select: HTMLSelectElement;
  source: string;
  value: string;
  text: string;
}>;

/** Explicitly opted-in, fixed public labels only. Option text/value, selection
 * and form events are never written. Records and values remain DOM-local. */
export class StaticSelectLabels {
  private records = new Map<HTMLOptionElement, Record>();

  private allowed(option: HTMLOptionElement): HTMLSelectElement | null {
    const select = option.closest("select");
    return select instanceof HTMLSelectElement &&
      select.getAttribute("data-translate-options") === "static" &&
      !option.closest("[data-no-translate], [data-translation-skip]")
      ? select
      : null;
  }

  private capture(option: HTMLOptionElement): Record {
    const previous = this.records.get(option);
    const currentLabel = option.getAttribute("label");
    const text = option.textContent ?? "";
    const value = option.value;
    const select = option.closest("select");
    const ownsLabel =
      !!previous?.written && currentLabel === previous.writtenLabel;
    const originalLabel = ownsLabel ? previous!.originalLabel : currentLabel;
    const record: Record = {
      originalLabel,
      originalText: text,
      value,
      select,
      written: ownsLabel,
      writtenLabel: ownsLabel ? previous!.writtenLabel : null,
    };
    // React can reuse an option for another authoritative value/source. Remove
    // our obsolete presentation before a new asynchronous translation arrives.
    if (
      ownsLabel &&
      (previous!.originalText !== text ||
        previous!.value !== value ||
        previous!.select !== select)
    ) {
      if (originalLabel === null) option.removeAttribute("label");
      else option.setAttribute("label", originalLabel);
      record.writtenLabel = originalLabel;
    }
    this.records.set(option, record);
    return record;
  }

  private restoreOne(option: HTMLOptionElement) {
    const record = this.capture(option);
    if (!record.written || option.getAttribute("label") !== record.writtenLabel)
      return;
    if (record.originalLabel === null) option.removeAttribute("label");
    else option.setAttribute("label", record.originalLabel);
    record.writtenLabel = record.originalLabel;
  }

  collect(root: HTMLElement): readonly StaticSelectLabel[] {
    for (const option of this.records.keys()) {
      if (!option.isConnected || !this.allowed(option)) {
        this.restoreOne(option);
        this.records.delete(option);
      }
    }
    const bindings: StaticSelectLabel[] = [];
    for (const option of root.querySelectorAll(
      "select[data-translate-options='static'] option",
    )) {
      if (!(option instanceof HTMLOptionElement)) continue;
      const select = this.allowed(option);
      if (!select) continue;
      const record = this.capture(option);
      const source = record.originalLabel ?? record.originalText;
      if (isTranslatableSource(source))
        bindings.push(
          Object.freeze({
            element: option,
            select,
            source,
            value: record.value,
            text: record.originalText,
          }),
        );
    }
    return Object.freeze(bindings);
  }

  write(binding: StaticSelectLabel, translated: string): boolean {
    const option = binding.element;
    if (
      !option.isConnected ||
      this.allowed(option) !== binding.select ||
      typeof translated !== "string" ||
      !translated.trim() ||
      translated.length > 2400
    )
      return false;
    const record = this.capture(option);
    if (
      (record.originalLabel ?? record.originalText) !== binding.source ||
      record.originalText !== binding.text ||
      record.value !== binding.value ||
      record.select !== binding.select
    )
      return false;
    record.written = true;
    record.writtenLabel = translated;
    if (option.getAttribute("label") !== translated)
      option.setAttribute("label", translated);
    return true;
  }

  restore(root: HTMLElement) {
    for (const option of this.records.keys()) {
      if (root.contains(option) || !option.isConnected) this.restoreOne(option);
      if (!option.isConnected) this.records.delete(option);
    }
  }

  needsSourceScan(mutation: MutationRecord): boolean {
    const element =
      mutation.target instanceof Element
        ? mutation.target
        : mutation.target.parentElement;
    if (!element) return false;
    if (
      mutation.type === "attributes" &&
      [
        "data-translate-options",
        "data-no-translate",
        "data-translation-skip",
      ].includes(mutation.attributeName ?? "")
    ) {
      return (
        !!element.querySelector("select[data-translate-options='static']") ||
        !!element.closest("select[data-translate-options='static']") ||
        element.matches("select[data-translate-options='static']") ||
        [...this.records.keys()].some((option) => element.contains(option))
      );
    }
    const option = element.closest("option");
    if (option instanceof HTMLOptionElement) {
      if (!this.allowed(option) && !this.records.has(option)) return false;
      if (
        mutation.type === "attributes" &&
        mutation.attributeName === "label"
      ) {
        const record = this.records.get(option);
        if (
          record?.written &&
          option.getAttribute("label") === record.writtenLabel
        )
          return false;
      }
      return true;
    }
    const select = element.closest("select");
    return (
      mutation.type === "childList" &&
      select instanceof HTMLSelectElement &&
      (select.getAttribute("data-translate-options") === "static" ||
        [...this.records.values()].some((record) => record.select === select))
    );
  }
}
