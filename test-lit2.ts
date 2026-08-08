import { LitElement } from 'lit';
import { property } from 'lit/decorators.js';
export class Test extends LitElement {
  @property() foo = 'bar';
}
