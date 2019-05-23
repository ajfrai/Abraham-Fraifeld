#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Created on Sun May 19 23:10:33 2019

@author: fraifeld-mba
"""

import sys

def absolute(x):
    if x < 0:
        return -x
    else:
        return x

def abs_dif(x,y):
    return absolute(x-y)    


for line in sys.stdin:
    r = [int(x) for x in line.split(" ")]
    sys.stdout.write(str(abs_dif(r[0],r[1]))+"\n")
