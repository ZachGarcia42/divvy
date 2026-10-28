// Width for an auto-sized amount input. A TextInput stretched across the sheet leaves the caret at its far edge on Android,
// away from the centred text (and ~20 characters wide on web), so the input is sized to what it shows and centred by its row.
// The placeholder's text is used while the field is empty so the caret sits inside "0.00".
export function amountWidth(text: string, placeholder: string, fontSize: number): number {
  const shown = text.length > 0 ? text : placeholder
  const em = [...shown].reduce((w, ch) => w + (/\d/.test(ch) ? 0.57 : 0.27), 0.4)
  return Math.ceil(em * fontSize)
}
