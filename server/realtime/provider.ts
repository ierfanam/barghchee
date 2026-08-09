export interface RealtimeProviderConfig {
  model: string;
  systemInstruction?: string;
  voice?: string;
}

export interface RealtimeProvider {
  readonly name: string;
  connect(config: RealtimeProviderConfig): Promise<void>;
  sendAudio(data: Buffer | Uint8Array): void;
  sendText(text: string): void;
  interrupt(): void;
  close(): Promise<void>;
}
