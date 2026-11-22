const quote = value => `'${String(value).replaceAll("'", "''")}'`;

export function curriculumStatements({ books }) {
  const sql = [];
  const senses = new Set();
  for (const [order, book] of books.entries()) {
    const units = new Set();
    for (const { unit, row, senseKey, term, meaning, accepted } of book.entries) {
      const id = quote(book.id);
      if (!Number.isSafeInteger(unit) || !Number.isSafeInteger(row)) throw Error("无效教材位置");
      if (!units.has(unit)) {
        units.add(unit);
        sql.push(`INSERT INTO curriculum_units(book,book_title,book_order,unit) VALUES(${id},${quote(book.title)},${order},${unit}) ON CONFLICT(book,unit) DO UPDATE SET book_title=excluded.book_title,book_order=excluded.book_order`);
      }
      const sense = quote(senseKey);
      if (!senses.has(senseKey)) {
        senses.add(senseKey);
        sql.push(`INSERT INTO curriculum_senses(sense_id,term,meaning,accepted_json) VALUES(${sense},${quote(term)},${quote(meaning)},${quote(JSON.stringify(accepted))}) ON CONFLICT(sense_id) DO UPDATE SET term=excluded.term,meaning=excluded.meaning,accepted_json=excluded.accepted_json`);
      }
      sql.push(`INSERT INTO curriculum_unit_senses(unit_id,sense_id,row_order) SELECT id,${sense},${row} FROM curriculum_units WHERE book=${id} AND unit=${unit} ON CONFLICT(unit_id,sense_id) DO UPDATE SET row_order=excluded.row_order`);
    }
  }
  return sql;
}

if (typeof process !== "undefined" && /(?:^|\/)build-curriculum-sql\.mjs$/.test(process.argv?.[1] ?? "")) {
  const { readFileSync } = await import("node:fs");
  const input = process.argv[2] ?? new URL("../data/curriculum/books.json", import.meta.url);
  console.log(curriculumStatements(JSON.parse(readFileSync(input, "utf8"))).join(";\n") + ";");
}
