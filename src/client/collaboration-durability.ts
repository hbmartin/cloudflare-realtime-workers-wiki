export class CollaborationDurability {
  private localGeneration = 0;
  private acknowledgedGeneration = 0;
  private pending = false;

  get hasUnsyncedChanges() {
    return this.pending;
  }

  markChanged() {
    this.localGeneration = Math.max(this.localGeneration, this.acknowledgedGeneration) + 1;
    this.pending = true;
  }

  barrierGeneration() {
    return this.pending ? this.localGeneration : null;
  }

  acknowledge(generation: number) {
    this.acknowledgedGeneration = Math.max(this.acknowledgedGeneration, generation);
    this.pending = this.acknowledgedGeneration < this.localGeneration;
  }
}
