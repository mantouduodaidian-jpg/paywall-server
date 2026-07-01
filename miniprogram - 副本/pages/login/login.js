const app = getApp();
const SCHOOLS = [
  { code: '', name: '选择学校' },
  { code: 'gxny', name: '广西农业职业技术大学' },
  { code: 'hnkj', name: '海南科技职业大学' },
  { code: 'gdcj', name: '广东财经大学' },
  { code: 'lztd', name: '柳州铁道职业技术学院' },
  
];

Page({
  data: {
    mode: 'login',
    // Login fields
    student_id: '', phone: '',
    // Register fields
    regName: '', regSid: '', regPhone: '', regGender: '', regNick: '', regSchool: '',
    cardImg: '',
    // Shared
    showSchoolPicker: false, schools: SCHOOLS, schoolNames: SCHOOLS.map(s => s.name),
    // Beta
    showBeta: false, betaPwd: '', betaMode: false, betaName: '', betaLoginPwd: '',
  },
  switchMode(e) { this.setData({ mode: e.currentTarget.dataset.mode }); },

  // === Beta entrance ===
  toggleBeta() { this.setData({ showBeta: !this.data.showBeta, betaPwd: '' }); },
  onBetaPwd(e) { this.setData({ betaPwd: e.detail.value }); },
  onBetaName(e) { this.setData({ betaName: e.detail.value }); },
  onBetaLoginPwd(e) { this.setData({ betaLoginPwd: e.detail.value }); },
  doBetaLoginSubmit() {
    var n = this.data.betaName.trim();
    var p = this.data.betaLoginPwd.trim();
    if (!n || !p) return app.toast("请输入用户名和密码");
    wx.showLoading({ title: "登录中" });
    app.request("/api/marketplace/beta-login", "POST", { name: n, password: p })
      .then(d => { wx.hideLoading();
        if (d.ok && d.user) {
          this.loginSuccess(d);
        } else app.toast(d.error || "登录失败");
      })
      .catch(() => { wx.hideLoading(); app.toast("网络错误"); });
  },
  doBetaLogin() {
    var pwd = this.data.betaPwd;
    if (!pwd) return app.toast('请输入内测密码');
    wx.showLoading({ title: '验证中' });
    app.request('/api/marketplace/beta-check', 'POST', { password: pwd })
      .then(d => { wx.hideLoading();
        if (d.ok && d.beta) this.setData({ betaMode: true, showBeta: false, mode: 'login' });
        else if (d.ok && !d.beta) app.toast('内测未开放');
        else app.toast(d.msg || '内测密码错误');
      })
      .catch(() => { wx.hideLoading(); app.toast('网络错误'); });
  },

  // === Login mode ===
  onIdInput(e) { this.setData({ student_id: e.detail.value }); },
  onPhoneInput(e) { this.setData({ phone: e.detail.value }); },

  doLogin() {
    const { student_id, phone } = this.data;
    if (!student_id || phone.length !== 11) return app.toast('请填写正确的学号和11位手机号');
    wx.showLoading({ title: '登录中' });
    app.request('/api/marketplace/login', 'POST', { student_id, phone })
      .then(d => { wx.hideLoading();
        if (d.ok && d.user) this.loginSuccess(d);
        else if (d.msg) app.toast(d.msg);
        else app.toast("账号不存在，请联系管理员添加");
      })
      .catch(() => { wx.hideLoading(); app.toast("网络错误"); });
  },
  phoneLogin(student_id, phone) {
    wx.showLoading({ title: '注册中' });
    app.request('/api/marketplace/phone-login', 'POST', { phone })
      .then(d => { wx.hideLoading();
        if (d.ok && d.user) { d.user.student_id = student_id; this.loginSuccess(d); }
        else app.toast('登录失败');
      })
      .catch(() => { wx.hideLoading(); app.toast('网络错误'); });
  },

  // === Register mode ===
  onRegName(e) { this.setData({ regName: e.detail.value }); },
  onRegSid(e) { this.setData({ regSid: e.detail.value }); },
  onRegPhone(e) { this.setData({ regPhone: e.detail.value }); },
  onRegNick(e) { this.setData({ regNick: e.detail.value }); },
  
  pickGender(e) { this.setData({ regGender: e.currentTarget.dataset.val }); },
  onRegSchool(e) {
    const s = SCHOOLS[e.detail.value];
    this.setData({ regSchool: s ? s.name : '' });
  },
  compressAndRead(path, cb) {
    wx.compressImage({ src: path, quality: 60,
      success: cp => {
        wx.getFileSystemManager().readFile({
          filePath: cp.tempFilePath, encoding: 'base64',
          success: r => cb('data:image/jpeg;base64,' + r.data),
          fail: () => { wx.getFileSystemManager().readFile({ filePath: path, encoding: 'base64', success: r => cb('data:image/jpeg;base64,' + r.data) }); }
        });
      },
      fail: () => {
        wx.getFileSystemManager().readFile({ filePath: path, encoding: 'base64', success: r => cb('data:image/jpeg;base64,' + r.data) });
      }
    });
  },
  uploadCard() {
    wx.chooseImage({ count: 1, sizeType: ['compressed'],
      success: res => this.compressAndRead(res.tempFilePaths[0], b64 => this.setData({ cardImg: b64 }))
    });
  },
  clearCard() { this.setData({ cardImg: '' }); },
  doRegister() {
    const d = this.data;
    if (!d.regName) return app.toast('请填写真实姓名');
    if (!d.regSid) return app.toast('请填写学号');
    if (d.regPhone.length !== 11) return app.toast('请输入11位手机号');
    if (!d.regGender) return app.toast('请选择性别');
    if (!d.cardImg) return app.toast('请上传学生证照片');

      const schoolCode = SCHOOLS.find(s => s.name === d.regSchool)?.code;
      if (!schoolCode) return app.toast('请选择学校');
      wx.showLoading({ title: '提交中' });
      app.request('/api/marketplace/login', 'POST', {
        name: d.regName, student_id: d.regSid, phone: d.regPhone,
        gender: d.regGender, nickname: d.regNick || '', school: schoolCode,
        image: d.cardImg || ''
      }).then(r => {
        wx.hideLoading();
        if (r.ok && r.user) {
          this.loginSuccess(r);
        } else if (r.ok) {
          app.toast(r.msg || '注册成功，等待审核', 'success');
          setTimeout(() => wx.navigateBack(), 1500);
        } else {
          app.toast(r.error || r.msg || '注册失败');
        }
      }).catch(() => { wx.hideLoading(); app.toast('网络错误'); });
  },

  // === Shared: login success → check school ===
  loginSuccess(d) {
    const u = d.user;
    // Beta entrance → auto-set school to 内测服
    if (this.data.betaMode || (this.data.showBeta && this.data.betaPwd)) {
      u.school = 'beta';
      app.globalData.user = u;
      app.globalData.token = d.token;
      wx.setStorageSync('user', u);
      wx.setStorageSync('token', d.token);
      wx.setStorageSync('userSchool', 'beta');
      app.connectWS();
      app.toast('登录成功', 'success');
      return wx.switchTab({ url: "/pages/index/index" });
    }
    const saved = wx.getStorageSync('userSchool') || '';
    u.school = u.school || saved || '';
    app.globalData.user = u;
    wx.setStorageSync('user', u);
    app.connectWS();
    if (u.school) {
      wx.setStorageSync('userSchool', u.school);
      app.toast('登录成功', 'success');
      wx.navigateBack();
    } else {
      this.setData({ showSchoolPicker: true });
    }
  },
  hidePicker() { this.setData({ showSchoolPicker: false }); },
  pickSchool(e) {
    const code = e.currentTarget.dataset.code;
    if (!code) return;
    const u = app.globalData.user;
    u.school = code;
    app.globalData.user = u;
    wx.setStorageSync('user', u);
    wx.setStorageSync('userSchool', code);
    this.setData({ showSchoolPicker: false });
    app.toast('登录成功', 'success');
    wx.navigateBack();
  }
});
