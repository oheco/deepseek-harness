/** Keeps each native text input linked to its draft across asynchronous UI updates. */
@Component
export struct ConnectionField {
  label: Resource = $r('app.string.connection_name');
  @Link value: string;
  @Prop secret: boolean = false;
  @Prop locked: boolean = false;
  onEdited: (value: string) => void = () => {};

  build() {
    Column({ space: 8 }) {
      Text(this.label).fontSize(14).fontColor($r('app.color.ink'))
      TextInput({ text: this.value, placeholder: this.label })
        .type(this.secret ? InputType.Password : InputType.Normal)
        .showPasswordIcon(this.secret).height(48).maxLength(this.secret ? 4096 : 2048)
        .fontColor($r('app.color.ink')).placeholderColor($r('app.color.muted'))
        .backgroundColor($r('app.color.card')).borderRadius(12)
        .border({ width: 1, color: $r('app.color.border') }).enabled(!this.locked)
        .onChange((value: string) => {
          this.onEdited(value);
          this.value = value;
        })
    }.width('100%').alignItems(HorizontalAlign.Start)
  }
}
