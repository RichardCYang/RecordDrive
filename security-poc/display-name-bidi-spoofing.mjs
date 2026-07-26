import { safeOriginalName } from '../src/utils.js';

const payloads = [
  `invoice.pdf\u202Eexe`,
  `C:\\Users\\Public\\report.docx\u2066fdp.exe\u2069`,
  `safe.txt\u0000hidden.exe`
];

for (const payload of payloads) {
  console.log(JSON.stringify({
    input: payload,
    inputCodePoints: [...payload].map((character) =>
      `U+${character.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`
    ),
    storedDisplayName: safeOriginalName(payload)
  }));
}
