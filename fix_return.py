with open('public/market.html', 'rb') as f:
    data = f.read()

# Find the blank line after unBadge and add return statement
marker = b"esc(c.name)+'</span>' : '';\n\n      }).join('');"
replacement = b"esc(c.name)+'</span>' : '';\n        return '<div class=\"chat-conv-item\" onclick=\"openChat('+c.product_id+',\\''+sid+'\\',\\''+esc(c.name)+'\\',\\'\\')\\">\\xf0\\x9f\\x92\\xac <span style=\"flex:1;overflow:hidden;text-overflow:ellipsis\">'+esc(c.name)+'</span>'+unBadge+'</div>';\n      }).join('');"

if marker in data:
    data = data.replace(marker, replacement)
    with open('public/market.html', 'wb') as f:
        f.write(data)
    print('DONE')
else:
    print('NOT FOUND')
