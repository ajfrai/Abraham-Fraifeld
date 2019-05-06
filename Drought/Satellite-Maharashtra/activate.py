#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Created on Tue Apr 23 12:34:24 2019

@author: fraifeld-mba
"""

import collect_bands as c
import requests
from requests.auth import HTTPBasicAuth

search_result = c.get_json()
image_ids = [feature['id'] for feature in search_result.json()['features']]
id0 = image_ids[0]

item_type = "PSScene4Band"

id0_url = 'https://api.planet.com/data/v1/item-types/{}/items/{}/assets'.format(item_type, id0)
result = \
  requests.get(
    id0_url,
    auth=HTTPBasicAuth(c.get_api_key()['key'],'')
  )

links = result.json()[u"analytic"]["_links"]
self_link = links["_self"]
activation_link = links["activate"]


activate_result = \
  requests.get(
    activation_link,
    auth=HTTPBasicAuth(c.get_api_key()['key'], '')
  )
  
activation_status_result = \
  requests.get(
    self_link,
    auth=HTTPBasicAuth(c.get_api_key()['key'], '')
  )
  
if activation_status_result.json()['status'] == 'active':  
    download_link = activation_status_result.json()["location"]
else:
    print("Resource inactive")

r = requests.get(download_link, allow_redirects=True)
open('data/EastMaharashtra/east_maharashtra.tif', 'wb').write(r.content)