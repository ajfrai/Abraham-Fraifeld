#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Created on Tue Jun 11 18:17:57 2019

@author: fraifeld-mba
"""

def hourglass_at(arr,i,j):
    if i > len(arr)-2:
        return None
    if j > len(arr[0])-2:
        return None
    
    return [
        arr[i][j],
        arr[i][j+1],
        arr[i][j+2],
        arr[i+1][j+1],
        arr[i+2][j],
        arr[i+2][j+1],
        arr[i+2][j+2]
    ]
    
def get_hourglasses(arr):
    hourglasses = []
    for i in range(len(arr)-2):
        for j in range(len(arr[i])-2):
            hourglasses.append(hourglass_at(arr,i,j))
    return hourglasses

def hourglassSum(arr):
    hourglasses = get_hourglasses(arr)
    max_sum = 0
    for i,h in enumerate(hourglasses):
        if sum(h) > max_sum:
            #max_glass = hourglasses[i]
            max_sum = sum(h)
    return max_sum

hourglassSum(arr)
