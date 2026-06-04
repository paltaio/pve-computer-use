import test from 'node:test'
import assert from 'node:assert/strict'

import { matchText } from './screen-match.js'

test('matchText uses exact substring matching for plain strings', () => {
	assert.equal(matchText({ pattern: 'Press any key' }, 'Press any key to continue').matched, true)
	assert.equal(matchText({ pattern: 'Press any key' }, 'Press 4ny key to continue').matched, false)
})

test('matchText uses exact regular expressions by default', () => {
	const pattern = /Welcome \w+/g

	assert.equal(matchText({ pattern }, 'Welcome admin').matched, true)
	assert.equal(matchText({ pattern }, 'Welcome admin').matched, true)
	assert.equal(matchText({ pattern }, 'Welc0me admin').matched, false)
})

test('matchText supports fuzzy string matching with a threshold', () => {
	const result = matchText({ pattern: 'Password', threshold: 0.8 }, 'Passw0rd:')

	assert.equal(result.matched, true)
	assert.equal(result.score, 0.875)
})

test('matchText finds fuzzy strings inside longer OCR text', () => {
	const result = matchText(
		{ pattern: 'Press any key', threshold: 0.82 },
		'Boot menu\nPr3ss any kcy to continue',
	)

	assert.equal(result.matched, true)
	assert.ok((result.score ?? 0) >= 0.82)
})

test('matchText rejects thresholds for regular expressions', () => {
	assert.throws(
		() => matchText({ pattern: /Password/i, threshold: 0.8 }, 'Passw0rd'),
		/Text threshold is only supported for string patterns/,
	)
})

test('matchText rejects invalid thresholds', () => {
	assert.throws(
		() => matchText({ pattern: 'Password', threshold: 1.1 }, 'Password'),
		/Text threshold must be between 0 and 1/,
	)
})
