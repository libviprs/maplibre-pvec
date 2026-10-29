/**
 * Marks a number as an acceptance budget stated in the issue (frame time, queue depth, a cap), as
 * opposed to a mathematical tolerance, which has to come from the shared numeric policy (P1.2).
 */
export const budget = (value: number): number => value;
