#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Created on Tue Apr 23 12:19:03 2019

@author: fraifeld-mba
"""

import os
import json
import requests
from requests.auth import HTTPBasicAuth

import filters

def get_api_key():
    lines = []
    with open("/Users/fraifeld-mba/Desktop/Satellite-Maharashtra/bin/planet_api_key.txt","r") as f:
        for line in f:
            lines.append(line.replace('\n',''))
    return {"email":lines[0],"key":lines[1]}

def get_json():
   

    item_type = "PSScene4Band"


    
 
    search_request = {
            "interval":"day",
            "item_types":[item_type],
            "filter": filters.combined_filter
            }
    
    search_result = requests.post(
            'https://api.planet.com/data/v1/quick-search',
            auth = HTTPBasicAuth(get_api_key()['key'],''),
            json = search_request)
    
    return search_result

