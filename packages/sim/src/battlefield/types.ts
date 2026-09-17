import type { ShapeId } from '@narok/data';
import type { Actor, ActorId, PositionId } from '../types';

export interface Battlefield {
  distance(a: PositionId, b: PositionId): number;
  inRange(a: PositionId, b: PositionId, range: number): boolean;
  placementSlots(side: Actor['side']): PositionId[];
  nextStep(actor: Actor, target: Actor, range: number, actors: Actor[]): PositionId | null;
  canReach(actor: Actor, target: Actor, range: number, actors: Actor[]): boolean;
  affected(primary: Actor, shape: ShapeId, eligible: Actor[]): ActorId[];
  validatePlacement(positions: PositionId[], side: Actor['side']): void;
}
