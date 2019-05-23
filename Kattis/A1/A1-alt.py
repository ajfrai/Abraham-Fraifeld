#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Created on Mon May 20 15:28:11 2019
solution failed on 4th test
@author: fraifeld-mba
"""

import sys
from math import ceil,sqrt,floor

def add_tape(n,cur_dim):
    n=floor(n)
    if n == 0:
        return 0
    
    if n == 1 or n == 2:
        return max(cur_dim)
    
    elif n%2 == 0:
        return (n/2)*max(cur_dim) + (n/2)*min(cur_dim)
    
    else:
        return ((n+1)/2)*max(cur_dim) + ((n+1)/2) * min(cur_dim)
    

def tape_len(n,available):
    

    cur_dim = [sqrt(2)*pow(2,-(5/4)),sqrt(2)*pow(2,-(3/4))]
    a1_area = cur_dim[0]*cur_dim[1]
    tape = 0
    covered_area = 0
    
    
    for i in range(n-1):
        cur_dim = [x/sqrt(2) for x in cur_dim]
        cur_area = cur_dim[0]*cur_dim[1]
        needed = floor(10*(a1_area-covered_area)/cur_area)/10
        
        if needed >  available[i]:
            covered_area = floor(100000 * (covered_area + available[i]*cur_area))/100000
            tape = tape+add_tape(available[i],cur_dim)
            
        else:
            tape = tape+add_tape(needed,cur_dim)
            return (ceil(100000*tape)/100000)
        
        
        
        
        
   
    return("impossible")
            



# read input
i = 0
for line in sys.stdin:
    if i == 0:
        n = int(line)
        i = 1
    else:
        available = [int(x) for x in line.split(" ")]
sys.stdout.write(str(tape_len(n,available))+"\n")