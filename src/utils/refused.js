/**
 * A refusal with a message fit to show the person who asked (a missing permission, a bad value...).
 * Discord commands and control panel changes report these as they are, and log anything else as a bug.
 */
export class Refused extends Error {}

export const refuse = (message) => {
  throw new Refused(message);
};
