import re

with open('public/market.html', 'rb') as f:
    data = f.read()

# Find: blank line followed by "      }).join('');"
pattern = b"\\n\\n      }).join('');"
idx = data.find(pattern)
if idx > 0:
    # Go back to find the unBadge line
    before = data[:idx]
    # Replace blank+join with return+join
    old_bytes = b"\\n\\n      }).join('');"
    new_bytes = b"\\n        return '<div class=\\\"chat-conv-item\\\" onclick=\\\"openChat('+c.product_id+',\\\\''+sid+'\\\\',\\\\''+esc(c.name)+'\\\\',\\\\'\\\\')\\\\">\\xf0\\x9f\\x92\\xac <span style=\\\"flex:1;overflow:hidden;text-overflow:ellipsis\\\">'+esc(c.name)+'</span>'+unBadge+'</div>';\\n      }).join('');"

    data = data.replace(old_bytes, new_bytes, 1)
    with open('public/market.html', 'wb') as f:
        f.write(data)
    print('DONE')
else:
    print('Pattern not found')
    try_idx = data.find(b"}).join('');")
    if try_idx > 0:
        print('Found join at', try_idx)
