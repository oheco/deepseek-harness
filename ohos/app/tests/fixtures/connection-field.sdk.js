if (!("finalizeConstruction" in ViewPU.prototype)) {
    Reflect.set(ViewPU.prototype, "finalizeConstruction", () => { });
}
export class ConnectionField extends ViewPU {
    constructor(parent, params, __localStorage, elmtId = -1, paramsLambda = undefined, extraInfo) {
        super(parent, __localStorage, elmtId, extraInfo);
        if (typeof paramsLambda === "function") {
            this.paramsGenerator_ = paramsLambda;
        }
        this.label = { "id": 16777244, "type": 10003, params: [], "bundleName": "org.oheco.deepseekharness", "moduleName": "entry" };
        this.__value = new SynchedPropertySimpleTwoWayPU(params.value, this, "value");
        this.__secret = new SynchedPropertySimpleOneWayPU(params.secret, this, "secret");
        this.__locked = new SynchedPropertySimpleOneWayPU(params.locked, this, "locked");
        this.onEdited = () => { };
        this.setInitiallyProvidedValue(params);
        this.finalizeConstruction();
    }
    setInitiallyProvidedValue(params) {
        if (params.label !== undefined) {
            this.label = params.label;
        }
        if (params.secret === undefined) {
            this.__secret.set(false);
        }
        if (params.locked === undefined) {
            this.__locked.set(false);
        }
        if (params.onEdited !== undefined) {
            this.onEdited = params.onEdited;
        }
    }
    updateStateVars(params) {
        this.__secret.reset(params.secret);
        this.__locked.reset(params.locked);
    }
    purgeVariableDependenciesOnElmtId(rmElmtId) {
        this.__value.purgeDependencyOnElmtId(rmElmtId);
        this.__secret.purgeDependencyOnElmtId(rmElmtId);
        this.__locked.purgeDependencyOnElmtId(rmElmtId);
    }
    aboutToBeDeleted() {
        this.__value.aboutToBeDeleted();
        this.__secret.aboutToBeDeleted();
        this.__locked.aboutToBeDeleted();
        SubscriberManager.Get().delete(this.id__());
        this.aboutToBeDeletedInternal();
    }
    label;
    __value;
    get value() {
        return this.__value.get();
    }
    set value(newValue) {
        this.__value.set(newValue);
    }
    __secret;
    get secret() {
        return this.__secret.get();
    }
    set secret(newValue) {
        this.__secret.set(newValue);
    }
    __locked;
    get locked() {
        return this.__locked.get();
    }
    set locked(newValue) {
        this.__locked.set(newValue);
    }
    onEdited;
    initialRender() {
        this.observeComponentCreation2((elmtId, isInitialRender) => {
            Column.create({ space: 8 });
            Column.width('100%');
            Column.alignItems(HorizontalAlign.Start);
        }, Column);
        this.observeComponentCreation2((elmtId, isInitialRender) => {
            Text.create(this.label);
            Text.fontSize(14);
            Text.fontColor({ "id": 16777308, "type": 10001, params: [], "bundleName": "org.oheco.deepseekharness", "moduleName": "entry" });
        }, Text);
        Text.pop();
        this.observeComponentCreation2((elmtId, isInitialRender) => {
            TextInput.create({ text: this.value, placeholder: this.label });
            TextInput.type(this.secret ? InputType.Password : InputType.Normal);
            TextInput.showPasswordIcon(this.secret);
            TextInput.height(48);
            TextInput.maxLength(this.secret ? 4096 : 2048);
            TextInput.fontColor({ "id": 16777308, "type": 10001, params: [], "bundleName": "org.oheco.deepseekharness", "moduleName": "entry" });
            TextInput.placeholderColor({ "id": 16777309, "type": 10001, params: [], "bundleName": "org.oheco.deepseekharness", "moduleName": "entry" });
            TextInput.backgroundColor({ "id": 16777307, "type": 10001, params: [], "bundleName": "org.oheco.deepseekharness", "moduleName": "entry" });
            TextInput.borderRadius(12);
            TextInput.border({ width: 1, color: { "id": 16777305, "type": 10001, params: [], "bundleName": "org.oheco.deepseekharness", "moduleName": "entry" } });
            TextInput.enabled(!this.locked);
            TextInput.onChange((value) => {
                this.onEdited(value);
                this.value = value;
            });
        }, TextInput);
        Column.pop();
    }
    rerender() {
        this.updateDirtyElements();
    }
}
