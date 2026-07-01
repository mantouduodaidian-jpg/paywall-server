const app = getApp();

Page({
  data: {
    product: null,
    loading: true,
    error: false,
    user: null,
    images: [],
    // Trade state
    tradeRole: '',          // 'seller' | 'buyer' | ''
    tradeStatus: '',        // 'trading' | 'awaiting_buyer' | 'completed' | ''
    tradeBuyer: null,
    // UI
    currentSwiper: 0,
    showDesc: false,
  },

  onLoad(options) {
    const user = app.globalData.user || wx.getStorageSync('user') || null;
    this.setData({ user });
    if (options.id) {
      this.loadProduct(options.id);
    } else {
      this.setData({ loading: false, error: true });
      app.toast('缺少商品ID');
    }
  },

  onShow() {
    const user = app.globalData.user || wx.getStorageSync('user') || null;
    if (this.data.product && (!user || !this.data.user || user.student_id !== this.data.user.student_id)) {
      this.setData({ user });
    }
  },

  onPullDownRefresh() {
    if (this.data.product) {
      this.loadProduct(this.data.product.id);
    }
    wx.stopPullDownRefresh();
  },

  loadProduct(id) {
    this.setData({ loading: true, error: false });
    app.request('/api/marketplace/products/' + id).then(res => {
      const p = res && (res.data || res);
      if (!p) {
        this.setData({ loading: false, error: true });
        return;
      }

      const images = [];
      if (p.images && Array.isArray(p.images)) {
        p.images.forEach(img => {
          if (typeof img === 'string') images.push(img);
          else if (img && img.url) images.push(img.url);
        });
      }
      if (images.length === 0 && p.image) images.push(p.image);

      // Determine trade role for current user
      let tradeRole = '';
      const user = this.data.user;
      if (user) {
        if (p.owner_student_id === user.student_id) {
          tradeRole = 'seller';
        } else if (p.trade_buyer_id === user.student_id) {
          tradeRole = 'buyer';
        }
      }

      wx.setNavigationBarTitle({ title: p.title || '商品详情' });

      this.setData({
        product: p,
        images,
        tradeRole,
        tradeStatus: p.trade_status || '',
        loading: false,
        error: false,
        currentSwiper: 0,
        showDesc: false,
        dateStr: (p.created_at || '').substring(0, 10),
      });

      // Load buyer info if available
      if (p.trade_buyer_id) {
        app.getNickCache().then(cache => {
          const nick = (cache && cache[p.trade_buyer_id]) || '';
          this.setData({ tradeBuyer: { student_id: p.trade_buyer_id, name: nick } });
        }).catch(() => {});
      }
    }).catch(err => {
      console.error(err);
      this.setData({ loading: false, error: true });
    });
  },

  onSwiperChange(e) {
    this.setData({ currentSwiper: e.detail.current });
  },

  toggleDesc() {
    this.setData({ showDesc: !this.data.showDesc });
  },

  // ─── Contact Seller ───
  contactSeller() {
    const p = this.data.product;
    const user = this.data.user;
    if (!user) {
      wx.navigateTo({ url: '/pages/login/login' });
      return;
    }
    if (!p || !p.owner_student_id) {
      app.toast('无法获取卖家信息');
      return;
    }
    // Navigate to chat with seller
    wx.navigateTo({
      url: '/pages/chat/chat?pid=' + p.id + '&sid=' + p.owner_student_id + '&name=' + encodeURIComponent('卖家')
    });
  },

  // ─── Trade Actions ───
  buyNow() {
    const user = this.data.user;
    if (!user) {
      wx.navigateTo({ url: '/pages/login/login' });
      return;
    }
    const p = this.data.product;
    if (!p) return;

    wx.showModal({
      title: '确认购买',
      content: '确定要购买「' + p.title + '」吗？',
      success: res => {
        if (res.confirm) {
          wx.showLoading({ title: '提交中...' });
          app.request('/api/marketplace/trade/confirm', 'POST', {
            product_id: p.id,
            student_id: user.student_id,
          }).then(d => {
            wx.hideLoading();
            if (d && d.ok) {
              app.toast('购买请求已发送', 'success');
              this.setData({ tradeStatus: 'trading', tradeRole: 'buyer' });
            } else {
              app.toast((d && d.error) || '操作失败');
            }
          }).catch(() => {
            wx.hideLoading();
            app.toast('网络错误');
          });
        }
      }
    });
  },

  confirmTrade() {
    const p = this.data.product;
    const user = this.data.user;
    if (!p || !user) return;

    wx.showModal({
      title: '确认交易',
      content: '确认与买家进行交易？',
      success: res => {
        if (res.confirm) {
          wx.showLoading({ title: '处理中...' });
          app.request('/api/marketplace/trade/confirm', 'POST', {
            product_id: p.id,
            seller_id: user.student_id,
          }).then(d => {
            wx.hideLoading();
            if (d && d.ok) {
              app.toast('已确认交易', 'success');
              this.setData({ tradeStatus: 'awaiting_buyer' });
            } else {
              app.toast((d && d.error) || '操作失败');
            }
          }).catch(() => {
            wx.hideLoading();
            app.toast('网络错误');
          });
        }
      }
    });
  },

  cancelTrade() {
    const p = this.data.product;
    const user = this.data.user;
    if (!p || !user) return;

    wx.showModal({
      title: '取消交易',
      content: '确定要取消这笔交易吗？',
      success: res => {
        if (res.confirm) {
          wx.showLoading({ title: '处理中...' });
          app.request('/api/marketplace/trade/cancel', 'POST', {
            product_id: p.id,
            student_id: user.student_id,
          }).then(d => {
            wx.hideLoading();
            if (d && d.ok) {
              app.toast('交易已取消');
              this.setData({ tradeStatus: '' });
            } else {
              app.toast((d && d.error) || '操作失败');
            }
          }).catch(() => {
            wx.hideLoading();
            app.toast('网络错误');
          });
        }
      }
    });
  },

  receiveGoods() {
    const p = this.data.product;
    const user = this.data.user;
    if (!p || !user) return;

    wx.showModal({
      title: '确认收货',
      content: '确认已收到商品？',
      success: res => {
        if (res.confirm) {
          wx.showLoading({ title: '处理中...' });
          app.request('/api/marketplace/trade/buyer-confirm', 'POST', {
            product_id: p.id,
            buyer_id: user.student_id,
          }).then(d => {
            wx.hideLoading();
            if (d && d.ok) {
              app.toast('已确认收货', 'success');
              this.setData({ tradeStatus: 'completed' });
              // Signal index page to refresh
              app.globalData._needRefresh = true;
            } else {
              app.toast((d && d.error) || '操作失败');
            }
          }).catch(() => {
            wx.hideLoading();
            app.toast('网络错误');
          });
        }
      }
    });
  },

  // ─── Navigation ───
  goBack() {
    try {
      wx.navigateBack({ delta: 1 });
    } catch (e) {
      wx.switchTab({ url: '/pages/index/index' });
    }
  },

  goChatWithBuyer() {
    const p = this.data.product;
    if (!p || !p.trade_buyer_id) return;
    wx.navigateTo({
      url: '/pages/chat/chat?pid=' + p.id + '&sid=' + p.trade_buyer_id + '&name=' + encodeURIComponent('买家')
    });
  },
});
