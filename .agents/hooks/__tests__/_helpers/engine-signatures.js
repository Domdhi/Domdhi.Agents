'use strict';

// Text that begins with one of these byte sequences made the engine drop the whole input as "a
// binary file" without a word: bytes a Write, a commit or a Read can all produce. Found by feeding
// the pinned v1.10.0 binary a table of magic numbers; each of these scanned 0 bytes.
//
// [label, prefix]. A key behind any of them must still be found on every path.

const SIGNATURES = [
    ['zip local header', 'PK\x03\x04'],
    ['zip empty archive', 'PK\x05\x06'],
    ['zip spanned', 'PK\x07\x08'],
    ['jar', 'PK\x03\x04\x14\0\x08\0'],
    ['bzip2', 'BZh91AY&SY'],
    ['rar 4', 'Rar!\x1a\x07\x00'],
    ['rar 5', 'Rar!\x1a\x07\x01\x00'],
    ['ar archive', '!<arch>\n'],
    ['deb', '!<arch>\ndebian-binary'],
    ['cab', 'MSCF\0\0\0\0'],
    ['pdf', '%PDF-1.4'],
    ['rtf', '{\\rtf1'],
    ['sqlite', 'SQLite format 3\0'],
    ['postscript', '%!PS-Adobe-3.0'],
    ['chrome extension', 'Cr24'],
    ['truetype', '\0\x01\0\0\0'],
    ['lzip', 'LZIP'],
    ['tar (ustar at offset 257)', 'a'.repeat(257) + 'ustar\0'],
    ['tar (GNU, at offset 257)', 'a'.repeat(257) + 'ustar  \0'],
];

module.exports = { SIGNATURES };
