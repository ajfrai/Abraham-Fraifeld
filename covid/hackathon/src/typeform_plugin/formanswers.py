#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Created on Thu Apr  9 16:21:34 2020

@author: fraifeld-mba
"""

import json
from bs4 import BeautifulSoup
import requests 

with open('typeform-secret.json','r') as f:
    auth = json.load(f)
    
attempt = requests.get("https://api.typeform.com/me",headers=auth)
test_id = "upytiA"

form_test = requests.get("https://api.typeform.com/forms/"+test_id+"/responses",headers=auth)

d = json.loads(form_test.text)

answers = [d['items'][i]["answers"] for i in range(len(d['items']))]