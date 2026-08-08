import { LitElement } from 'lit';
import { customElement, property } from 'lit/decorators.js';
@customElement('test-element')
export class Test extends LitElement {
  @property() foo = 'bar';
}
