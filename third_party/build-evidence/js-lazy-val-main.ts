export class Lazy<T> {
  private _value: Promise<T> | null = null
  private creator: (() => Promise<T>) | null

  constructor(creator: () => Promise<T>) {
    this.creator = creator
  }

  get hasValue() {
    return this.creator == null
  }

  get value(): Promise<T> {
    if (this.creator == null) {
      return this._value!!
    }

    const result = this.creator()
    this.value = result
    return result
  }

  set value(value: Promise<T>) {
    this._value = value
    this.creator = null
  }
}