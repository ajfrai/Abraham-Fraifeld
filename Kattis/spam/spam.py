#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Created on Mon May 20 18:29:54 2019

@author: fraifeld-mba
"""

import re
import sys 

white = re.compile("_")
sym = re.compile("[^A-Za-z_]")
up = re.compile("[A-Z]")
low = re.compile("[a-z]")

expressions = [white,low,up,sym]

for line in sys.stdin:
    line=line[:len(line)-1]
    total = len(line)
    for e in expressions:
        sys.stdout.write(str(len(re.findall(e,line))/total)+"\n")
    
