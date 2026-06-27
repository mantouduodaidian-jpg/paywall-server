with open('public/market.html', 'r', encoding='utf-8') as f:
    html = f.read()

old = "var prodCount = c.products && c.products.length > 1 ? ' <span style=\"color:#60b88e;font-size:10px\">('+c.products.length+'笔)</span>' : '';\n\treturn '<div class=\"chat-conv-item\" onclick=\"openChat('+c.product_id+',\\''+sid+'\\',\\''+esc(c.name)+'\\',\\'\\')\\">💬 <span style=\"flex:1;overflow:hidden;text-overflow:ellipsis\">'+esc(c.name)+'</span>'+prodCount+unBadge+'</div>';"
new = "return '<div class=\"chat-conv-item\" onclick=\"openChat('+c.product_id+',\\''+sid+'\\',\\''+esc(c.name)+'\\',\\'\\')\\">💬 <span style=\"flex:1;overflow:hidden;text-overflow:ellipsis\">'+esc(c.name)+'</span>'+unBadge+'</div>';"

if old in html:
    html = html.replace(old, new)
    with open('public/market.html', 'w', encoding='utf-8') as f:
        f.write(html)
    print('DONE')
else:
    print('NOT FOUND')
    idx = html.find('prodCount')
    if idx > 0:
        print('Found at', idx)
        print(repr(html[idx:idx+300]))
