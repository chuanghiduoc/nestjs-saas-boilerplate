import { Injectable } from '@nestjs/common';

/** Cờ "đang tắt": bật một lần khi nhận signal, từ đó readiness trả 503 (liveness vẫn 200). */
@Injectable()
export class Draining {
  private draining = false;
  isDraining(): boolean {
    return this.draining;
  }
  start(): void {
    this.draining = true;
  }
}
