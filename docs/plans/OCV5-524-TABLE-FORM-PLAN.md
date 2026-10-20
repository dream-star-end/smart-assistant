# OCV5-524 实测旧表格表单归属修正（写码前）

当前8a77bfcff 54项fixture/类型/三批代码审查均通过，但一次真实public GET预检失败（无账号、POST或模型）。只读HTML结构分析确认：200 UTF8 7794B、1个POST目标/e/member/doaction.php，12个input全部词法处于form内部；parse5 DOM的form是table子节点，childCount=0、start=end4063/endTag缺失，所有input/image不在form后代。证据H/g524-public-form-{readonly,dom,table-layout}-metadata.json，只含元数据/长度，没有values或Cookie。

不能为此扫全页猜表单或用正则解析HTML。拟按parse5真实解析时form指针关联：8.0.1已exact锁定，导出的Parser及其formElement/_attachElementToTree为internal API，局限明确记录；小子类在super._attachElementToTree后，把HTML namespace的input/img实际node与当时this.formElement记录到WeakMap；template中不记录。tokenizer继续由原Parser驱动，script/comment内伪tag不会参与，真正</form>会清掉指针，因此表格中后续未归属控件不被偷入。

parseJieyouLoginForm改用该Parser的document和owner Map选择每个真实form的输入/验证码，而非elements(form)后代。其余精确action/path、唯一候选、known hidden、required name/type、radio选择、duplicate/资源上限不变。显式form=属性在本固定站点先明确拒绝（原页面无该属性），防止把override到别处的input仍认作当前form；不宣称实现通用浏览器完整form-owner算法。没有全局fallback/字段放宽/JS执行/新依赖。

新增回归：合成相同<table><form>布局（parse5会将控件移出form）仍正确取全部字段/验证码；真正</form>之后的同table key不能满足当前表单；script/comment里伪</form>不结束表单；template伪控件不参与；显式form=拒绝，保持原正常表单/duplicate/外域拒绝。做一个具体红绿证明：在旧DOM后代实现上新legacy fixture失败，恢复parser-owner实现后绿；源码原字节恢复。产品测试及真实native GET预检依wait-for-trains+mutex让路，当前其它会话发布时不占锁。只读公开结构调查按原任务单独进行，未抢测试/发布资源。

APPROVED后实现，同PR提交推送，代码复审新diff、frozen typecheck/Biome/CI。修复后只做一次真实public login页GET预检（无凭据/验证码请求/POST），只记计数/路径/names/选项数，不记值或cookies。仍不能称登录成功或市场可用，账号文件路径尚未收到。
