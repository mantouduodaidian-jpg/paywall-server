var app = getApp();

Page({
  data: {
    mode: 'login',
    studentId: '',
    phone: '',
    name: '',
    nickname: '',
    school: '',
    schools: ['广西农业职业技术大学', '海南科技职业大学', '广东财经大学', '柳州铁道职业技术学院'],
    gender: '',
    cardImage: '',
    cardImageName: '',
    logoUrl: '',
    submitting: false
  },

  onLoad(e) {
    if (e && e.mode === 'beta') {
      this.setData({ mode: 'beta' });
    }
    // check if already logged in
    if (app.globalData.user) {
      wx.navigateBack();
    }
  },

  switchMode(e) {
    var mode = e.currentTarget.dataset.mode;
    this.setData({ mode: mode });
  },

  onInput(e) {
    var field = e.currentTarget.dataset.field;
    var val = e.detail.value;
    var obj = {};
    obj[field] = val;
    this.setData(obj);
  },

  setGender(e) {
    this.setData({ gender: e.currentTarget.dataset.gender });
  },

  onSchoolChange(e) {
    var idx = e.detail.value;
    this.setData({ school: this.data.schools[idx] });
  },

  uploadCard() {
    var self = this;
    wx.chooseImage({
      count: 1,
      sizeType: ['compressed'],
      success: function (res) {
        var tempPath = res.tempFilePaths[0];
        // Upload to server
        wx.uploadFile({
          url: 'https://paywall-server.onrender.com/api/upload',
          filePath: tempPath,
          name: 'file',
          success: function (r) {
            try {
              var d = JSON.parse(r.data);
              if (d && d.url) {
                self.setData({ cardImage: 'https://paywall-server.onrender.com' + d.url, cardImageName: '学生证已上传' });
              }
            } catch (e) { }
          }
        });
      }
    });
  },

  doRegister() {
    var self = this;
    var d = this.data;
    if (!d.name) { wx.showToast({ title: '请输入姓名', icon: 'none' }); return; }
    if (!d.studentId) { wx.showToast({ title: '请输入学号', icon: 'none' }); return; }
    if (!d.phone || d.phone.length < 11) { wx.showToast({ title: '请输入11位手机号', icon: 'none' }); return; }
    if (!d.school) { wx.showToast({ title: '请选择学校', icon: 'none' }); return; }

    this.setData({ submitting: true });
    app.request('/api/marketplace/login', 'POST', {
      name: d.name,
      student_id: d.studentId,
      phone: d.phone,
      gender: d.gender,
      nickname: d.nickname,
      school: d.school,
      image: d.cardImage.replace('https://paywall-server.onrender.com', '')
    }).then(function (r) {
      if (r && r.user) {
        app.globalData.user = r.user;
        app.globalData.token = r.token;
        wx.setStorageSync('user', r.user);
        wx.setStorageSync('token', r.token || '');
        app.connectWS();
        wx.showToast({ title: '注册成功', icon: 'success' });
        setTimeout(function () { wx.navigateBack(); }, 1500);
      } else {
        wx.showToast({ title: r.error || '注册失败', icon: 'none' });
      }
    }).catch(function () {
      wx.showToast({ title: '网络错误', icon: 'none' });
    }).finally(function () {
      self.setData({ submitting: false });
    });
  },

  doLogin() {
    var self = this;
    var d = this.data;
    if (!d.studentId) { wx.showToast({ title: '请输入学号', icon: 'none' }); return; }
    if (!d.phone || d.phone.length < 11) { wx.showToast({ title: '请输入11位手机号', icon: 'none' }); return; }

    this.setData({ submitting: true });
    app.login(d.studentId, d.phone)
      .then(function (user) {
        wx.showToast({ title: '登录成功', icon: 'success' });
        setTimeout(function () { wx.navigateBack(); }, 1500);
      })
      .catch(function (e) {
        wx.showToast({ title: e.message || '登录失败', icon: 'none' });
      })
      .finally(function () {
        self.setData({ submitting: false });
      });
  },

  enterBeta() {
    var self = this;
    wx.showModal({
      title: '内测登录',
      content: '请输入内测密码',
      editable: true,
      placeholderText: '内测密码',
      success: function (res) {
        if (res.confirm && res.content) {
          self.doBetaLogin(res.content);
        }
      }
    });
  },

  doBetaLogin(password) {
    var self = this;
    app.request('/api/marketplace/beta-check', 'POST', { password: password })
      .then(function (r) {
        if (r && r.ok) {
          app.globalData.user = r.user;
          app.globalData.token = r.token;
          wx.setStorageSync('user', r.user);
          wx.setStorageSync('token', r.token || '');
          app.connectWS();
          wx.showToast({ title: '内测登录成功', icon: 'success' });
          setTimeout(function () { wx.navigateBack(); }, 1500);
        } else {
          wx.showToast({ title: '密码错误', icon: 'none' });
        }
      });
  }
});
