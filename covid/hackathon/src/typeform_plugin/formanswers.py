#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Created on Thu Apr  9 16:21:34 2020

@author: fraifeld-mba
"""

import json
from bs4 import BeautifulSoup
import requests 

with open('hackathon/typeform-secret.json','r') as f:
    auth = json.load(f)

test_id = "osi208"

form_test = requests.get("https://api.typeform.com/forms/"+test_id+"/responses",headers=auth)

d = json.loads(form_test.text)

answers = [d['items'][i]["answers"] for i in range(len(d['items']))]