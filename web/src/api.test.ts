import { expect, test } from 'vitest';
import { ApiError, describeError } from './api';

/**
 * A refused save has to say what was refused. "Invalid prompt" on its own sends
 * you looking through five tabs for a field the server already named.
 */

test('a validation failure names the field and the reason', () => {
  const error = new ApiError('Invalid prompt', 400, {
    fieldErrors: { repoUrl: ['Use an https:// or git@host:owner/repo URL'] },
  });

  expect(describeError(error)).toBe('Invalid prompt — repoUrl: Use an https:// or git@host:owner/repo URL');
});

test('an error with nothing to add is left as it is', () => {
  expect(describeError(new ApiError('Not found', 404))).toBe('Not found');
  expect(describeError(new Error('network died'))).toBe('network died');
  expect(describeError('a string somebody threw')).toBe('a string somebody threw');
});

test('a wall of field errors is cut to something readable', () => {
  const fieldErrors = Object.fromEntries(
    Array.from({ length: 10 }, (_, index) => [`field${index}`, [`reason ${index}`]]),
  );

  const described = describeError(new ApiError('Invalid', 400, { fieldErrors }));
  expect(described.split(';').length).toBe(4);
});
