#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Created on Tue Jun 11 18:48:54 2019

@author: fraifeld-mba
"""

def farthest_substring_of_fixed_size(s,size):
    start = 0
    most_far = ""
    while start < len(s):
        if start+size > len(s):
            break
        if s[start:start+size] > most_far:
            most_far = s[start:start+size]
        start = start+1
    return most_far
        

def enumerate_all_substrings(s):
    all_s = []
    for size in range(1,len(s)+1):
        #print(size)
        all_s.append(farthest_substring_of_fixed_size(s,size))
    return all_s
            
        

def maxSubstring(s):
    all_s = enumerate_all_substrings(s)
    return sorted(all_s)[len(all_s)-1]
